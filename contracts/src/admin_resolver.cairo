/// AdminResolver -- Admin-based outcome resolution for Market-Zap MVP.
///
/// Flow:
/// 1. Admin calls `propose_outcome` after market resolution_time.
/// 2. A 24-hour dispute window begins.
/// 3. Admin may `override_proposal` during the window (resets timer).
/// 4. Anyone calls `finalize_resolution` after the window elapses,
///    which reports payouts to ConditionalTokens.

#[starknet::contract]
pub mod AdminResolver {
    // -----------------------------------------------------------------
    //  Imports
    // -----------------------------------------------------------------
    use core::num::traits::Zero;
    use starknet::{
        ContractAddress, get_caller_address, get_block_timestamp,
        storage::{Map, StorageMapReadAccess, StorageMapWriteAccess},
    };
    use starknet::storage::StoragePointerReadAccess;
    use starknet::storage::StoragePointerWriteAccess;

    use openzeppelin_upgrades::UpgradeableComponent;
    use starknet::class_hash::ClassHash;

    use market_zap::interfaces::i_admin_resolver::{ResolutionStatus, Proposal};
    use market_zap::interfaces::i_conditional_tokens::{
        IConditionalTokensDispatcher, IConditionalTokensDispatcherTrait,
    };
    use market_zap::interfaces::i_market_factory::{
        IMarketFactoryDispatcher, IMarketFactoryDispatcherTrait,
    };

    // -----------------------------------------------------------------
    //  Components
    // -----------------------------------------------------------------
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    // -----------------------------------------------------------------
    //  Constants
    // -----------------------------------------------------------------
    /// Default dispute period: 24 hours.
    const DEFAULT_DISPUTE_PERIOD: u64 = 24 * 60 * 60;
    /// 48-hour upgrade timelock.
    const UPGRADE_TIMELOCK_SECONDS: u64 = 48 * 60 * 60;

    // -----------------------------------------------------------------
    //  Storage
    // -----------------------------------------------------------------
    #[storage]
    struct Storage {
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        /// Admin address.
        admin: ContractAddress,
        /// ConditionalTokens contract address.
        conditional_tokens: ContractAddress,
        /// MarketFactory contract address (for void_resolve checks).
        market_factory: ContractAddress,
        /// Configurable dispute period (seconds).
        dispute_period: u64,
        /// condition_id -> Proposal.
        proposals: Map<felt252, Proposal>,
        /// condition_id -> outcome_count (cached from CT for payout construction).
        condition_outcome_counts: Map<felt252, u32>,
        /// Upgrade timelock fields.
        proposed_upgrade: ClassHash,
        upgrade_proposed_at: u64,
    }

    // -----------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------
    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
        OutcomeProposed: OutcomeProposed,
        ProposalOverridden: ProposalOverridden,
        ResolutionFinalized: ResolutionFinalized,
        DisputePeriodUpdated: DisputePeriodUpdated,
        AdminTransferred: AdminTransferred,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OutcomeProposed {
        #[key]
        pub condition_id: felt252,
        pub proposed_outcome: u32,
        pub proposed_at: u64,
        pub dispute_deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ProposalOverridden {
        #[key]
        pub condition_id: felt252,
        pub old_outcome: u32,
        pub new_outcome: u32,
        pub new_deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ResolutionFinalized {
        #[key]
        pub condition_id: felt252,
        pub winning_outcome: u32,
    }

    #[derive(Drop, starknet::Event)]
    pub struct DisputePeriodUpdated {
        pub old_period: u64,
        pub new_period: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AdminTransferred {
        pub old_admin: ContractAddress,
        pub new_admin: ContractAddress,
    }

    // -----------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------
    pub mod Errors {
        pub const CALLER_NOT_ADMIN: felt252 = 'AR: caller != admin';
        pub const ALREADY_PROPOSED: felt252 = 'AR: already proposed';
        pub const NOT_PROPOSED: felt252 = 'AR: no active proposal';
        pub const ALREADY_FINALIZED: felt252 = 'AR: already finalized';
        pub const DISPUTE_NOT_ELAPSED: felt252 = 'AR: dispute window open';
        pub const DISPUTE_WINDOW_CLOSED: felt252 = 'AR: dispute window closed';
        pub const INVALID_OUTCOME: felt252 = 'AR: invalid outcome index';
        pub const ZERO_ADDRESS: felt252 = 'AR: zero address';
        pub const ZERO_PERIOD: felt252 = 'AR: zero dispute period';
        pub const MARKET_NOT_VOIDED: felt252 = 'AR: market not voided';
        pub const RESOLUTION_TOO_EARLY: felt252 = 'AR: before resolution_time';
        pub const UPGRADE_NOT_PROPOSED: felt252 = 'AR: no pending upgrade';
        pub const UPGRADE_TIMELOCK: felt252 = 'AR: timelock not elapsed';
    }

    // -----------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------
    #[constructor]
    fn constructor(
        ref self: ContractState,
        admin: ContractAddress,
        conditional_tokens: ContractAddress,
        market_factory: ContractAddress,
    ) {
        assert(!admin.is_zero(), Errors::ZERO_ADDRESS);
        self.admin.write(admin);
        self.conditional_tokens.write(conditional_tokens);
        self.market_factory.write(market_factory);
        self.dispute_period.write(DEFAULT_DISPUTE_PERIOD);
    }

    // -----------------------------------------------------------------
    //  Access modifier
    // -----------------------------------------------------------------
    #[generate_trait]
    impl AccessImpl of AccessTrait {
        fn assert_only_admin(self: @ContractState) {
            assert(get_caller_address() == self.admin.read(), Errors::CALLER_NOT_ADMIN);
        }
    }

    // -----------------------------------------------------------------
    //  Upgrade with 48-hour timelock
    // -----------------------------------------------------------------
    #[abi(embed_v0)]
    impl UpgradeTimelockImpl of super::IResolverUpgradeTimelock<ContractState> {
        fn propose_upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            self.assert_only_admin();
            let now = get_block_timestamp();
            self.proposed_upgrade.write(new_class_hash);
            self.upgrade_proposed_at.write(now);
        }

        fn execute_upgrade(ref self: ContractState) {
            self.assert_only_admin();
            let proposed = self.proposed_upgrade.read();
            assert(proposed.is_non_zero(), Errors::UPGRADE_NOT_PROPOSED);
            let proposed_at = self.upgrade_proposed_at.read();
            let now = get_block_timestamp();
            assert(now >= proposed_at + UPGRADE_TIMELOCK_SECONDS, Errors::UPGRADE_TIMELOCK);
            self.proposed_upgrade.write(Zero::zero());
            self.upgrade_proposed_at.write(0);
            self.upgradeable.upgrade(proposed);
        }
    }

    // -----------------------------------------------------------------
    //  IAdminResolver implementation
    // -----------------------------------------------------------------
    #[abi(embed_v0)]
    impl AdminResolverImpl of market_zap::interfaces::i_admin_resolver::IAdminResolver<
        ContractState,
    > {
        fn propose_outcome(
            ref self: ContractState,
            market_id: u64,
            condition_id: felt252,
            proposed_outcome: u32,
        ) {
            self.assert_only_admin();

            // Must not have an existing proposal or finalized resolution.
            let existing = self.proposals.read(condition_id);
            assert(existing.status == ResolutionStatus::None, Errors::ALREADY_PROPOSED);

            // C5h: Enforce resolution_time — cannot propose before market ends.
            let mf = IMarketFactoryDispatcher {
                contract_address: self.market_factory.read(),
            };
            let market = mf.get_market(market_id);
            assert(market.condition_id == condition_id, Errors::INVALID_OUTCOME);
            let now = get_block_timestamp();
            assert(now >= market.resolution_time, Errors::RESOLUTION_TOO_EARLY);

            // Fetch the condition from ConditionalTokens to validate outcome index.
            let ct = IConditionalTokensDispatcher {
                contract_address: self.conditional_tokens.read(),
            };
            let condition_view = ct.get_condition(condition_id);
            assert(proposed_outcome < condition_view.outcome_count, Errors::INVALID_OUTCOME);

            // Cache outcome_count for finalization.
            self.condition_outcome_counts.write(condition_id, condition_view.outcome_count);

            let now = get_block_timestamp();
            let dp = self.dispute_period.read();

            let proposal = Proposal {
                condition_id,
                proposed_outcome,
                proposed_at: now,
                dispute_period: dp,
                status: ResolutionStatus::Proposed,
            };
            self.proposals.write(condition_id, proposal);

            self
                .emit(
                    OutcomeProposed {
                        condition_id,
                        proposed_outcome,
                        proposed_at: now,
                        dispute_deadline: now + dp,
                    },
                );
        }

        fn finalize_resolution(ref self: ContractState, condition_id: felt252) {
            let proposal = self.proposals.read(condition_id);
            assert(proposal.status == ResolutionStatus::Proposed, Errors::NOT_PROPOSED);

            let now = get_block_timestamp();
            let deadline = proposal.proposed_at + proposal.dispute_period;
            assert(now >= deadline, Errors::DISPUTE_NOT_ELAPSED);

            // Mark as finalized.
            let finalized = Proposal {
                status: ResolutionStatus::Finalized,
                ..proposal,
            };
            self.proposals.write(condition_id, finalized);

            // Build payout numerators: winning outcome gets 1, rest get 0.
            let outcome_count = self.condition_outcome_counts.read(condition_id);
            let mut numerators: Array<u256> = array![];
            let mut i: u32 = 0;
            while i < outcome_count {
                if i == proposal.proposed_outcome {
                    numerators.append(1);
                } else {
                    numerators.append(0);
                }
                i += 1;
            };

            // Report to ConditionalTokens.
            let ct = IConditionalTokensDispatcher {
                contract_address: self.conditional_tokens.read(),
            };
            ct.report_payouts(condition_id, numerators.span());

            self
                .emit(
                    ResolutionFinalized {
                        condition_id,
                        winning_outcome: proposal.proposed_outcome,
                    },
                );
        }

        fn override_proposal(
            ref self: ContractState,
            condition_id: felt252,
            new_outcome: u32,
        ) {
            self.assert_only_admin();

            let proposal = self.proposals.read(condition_id);
            assert(proposal.status == ResolutionStatus::Proposed, Errors::NOT_PROPOSED);

            // Must still be within the dispute window.
            let now = get_block_timestamp();
            let deadline = proposal.proposed_at + proposal.dispute_period;
            assert(now < deadline, Errors::DISPUTE_WINDOW_CLOSED);

            // Validate new outcome.
            let outcome_count = self.condition_outcome_counts.read(condition_id);
            assert(new_outcome < outcome_count, Errors::INVALID_OUTCOME);

            let old_outcome = proposal.proposed_outcome;
            let dp = self.dispute_period.read();

            // Reset timer with new proposal.
            let updated = Proposal {
                condition_id,
                proposed_outcome: new_outcome,
                proposed_at: now,
                dispute_period: dp,
                status: ResolutionStatus::Proposed,
            };
            self.proposals.write(condition_id, updated);

            self
                .emit(
                    ProposalOverridden {
                        condition_id,
                        old_outcome,
                        new_outcome,
                        new_deadline: now + dp,
                    },
                );
        }

        fn void_resolve(ref self: ContractState, market_id: u64, condition_id: felt252) {
            // Anyone can call, but the market must be voided on MarketFactory.
            let mf = IMarketFactoryDispatcher {
                contract_address: self.market_factory.read(),
            };
            let market = mf.get_market(market_id);
            assert(market.voided, Errors::MARKET_NOT_VOIDED);
            assert(market.condition_id == condition_id, Errors::INVALID_OUTCOME);

            // Must not already be finalized.
            let existing = self.proposals.read(condition_id);
            assert(existing.status != ResolutionStatus::Finalized, Errors::ALREADY_FINALIZED);

            // Fetch outcome count.
            let ct = IConditionalTokensDispatcher {
                contract_address: self.conditional_tokens.read(),
            };
            let condition_view = ct.get_condition(condition_id);

            // Build equal-split payouts (1 per outcome).
            let mut numerators: Array<u256> = array![];
            let mut i: u32 = 0;
            while i < condition_view.outcome_count {
                numerators.append(1);
                i += 1;
            };

            // Report equal payouts to ConditionalTokens.
            ct.report_payouts(condition_id, numerators.span());

            // Mark as finalized.
            let finalized = Proposal {
                condition_id,
                proposed_outcome: 0, // N/A for void
                proposed_at: get_block_timestamp(),
                dispute_period: 0,
                status: ResolutionStatus::Finalized,
            };
            self.proposals.write(condition_id, finalized);

            self.emit(ResolutionFinalized { condition_id, winning_outcome: 0 });
        }

        fn set_dispute_period(ref self: ContractState, new_period: u64) {
            self.assert_only_admin();
            assert(new_period > 0, Errors::ZERO_PERIOD);

            let old_period = self.dispute_period.read();
            self.dispute_period.write(new_period);

            self.emit(DisputePeriodUpdated { old_period, new_period });
        }

        fn transfer_admin(ref self: ContractState, new_admin: ContractAddress) {
            self.assert_only_admin();
            assert(!new_admin.is_zero(), Errors::ZERO_ADDRESS);

            let old_admin = self.admin.read();
            self.admin.write(new_admin);

            self.emit(AdminTransferred { old_admin, new_admin });
        }

        // -----------------------------------------------------------------
        //  Views
        // -----------------------------------------------------------------
        fn get_proposal(self: @ContractState, condition_id: felt252) -> Proposal {
            self.proposals.read(condition_id)
        }

        fn get_dispute_period(self: @ContractState) -> u64 {
            self.dispute_period.read()
        }

        fn get_admin(self: @ContractState) -> ContractAddress {
            self.admin.read()
        }
    }
}

// -----------------------------------------------------------------
//  Upgrade timelock interface (contract-local)
// -----------------------------------------------------------------
use starknet::class_hash::ClassHash;

#[starknet::interface]
pub trait IResolverUpgradeTimelock<TContractState> {
    fn propose_upgrade(ref self: TContractState, new_class_hash: ClassHash);
    fn execute_upgrade(ref self: TContractState);
}
