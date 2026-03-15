/// MarketFactory -- Market creation and lifecycle management for Market-Zap.
///
/// Creators post a $20 USDC bond which is refunded once volume exceeds $100
/// AND the market has been resolved or voided.
/// Markets can be voided permissionlessly if unresolved 14 days after
/// resolution_time.

#[starknet::contract]
pub mod MarketFactory {
    // -----------------------------------------------------------------
    //  Imports
    // -----------------------------------------------------------------
    use core::hash::HashStateTrait;
    use core::num::traits::Zero;
    use core::poseidon::PoseidonTrait;
    use starknet::{
        ContractAddress, get_caller_address, get_contract_address, get_block_timestamp,
        storage::{Map, StorageMapReadAccess, StorageMapWriteAccess, Vec, VecTrait, MutableVecTrait},
    };
    use starknet::storage::StoragePointerReadAccess;
    use starknet::storage::StoragePointerWriteAccess;

    use openzeppelin_access::ownable::OwnableComponent;
    use openzeppelin_upgrades::UpgradeableComponent;
    use openzeppelin_interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::class_hash::ClassHash;

    use market_zap::interfaces::i_market_factory::Market;
    use market_zap::interfaces::i_conditional_tokens::{
        IConditionalTokensDispatcher, IConditionalTokensDispatcherTrait,
    };

    // -----------------------------------------------------------------
    //  Components
    // -----------------------------------------------------------------
    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);

    #[abi(embed_v0)]
    impl OwnableMixinImpl = OwnableComponent::OwnableMixinImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    // -----------------------------------------------------------------
    //  Constants
    // -----------------------------------------------------------------
    /// Bond amount: $20 USDC = 20 * 10^6 (USDC has 6 decimals).
    const BOND_AMOUNT: u256 = 20_000_000;
    /// Volume threshold for bond refund: $100 USDC = 100 * 10^6.
    const VOLUME_THRESHOLD: u256 = 100_000_000;
    /// Void grace period: 14 days in seconds.
    const VOID_GRACE_PERIOD: u64 = 14 * 24 * 60 * 60;
    /// 48-hour upgrade timelock.
    const UPGRADE_TIMELOCK_SECONDS: u64 = 48 * 60 * 60;
    /// Max page size for paginated queries.
    const MAX_PAGE_SIZE: u64 = 50;

    // -----------------------------------------------------------------
    //  Storage
    // -----------------------------------------------------------------
    #[storage]
    struct Storage {
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        /// ConditionalTokens contract address.
        conditional_tokens: ContractAddress,
        /// CLOBExchange contract address (authorized to call increment_volume).
        clob_exchange: ContractAddress,
        /// Bond token address (always USDC, set at construction).
        bond_token: ContractAddress,
        /// Auto-incrementing market id counter.
        next_market_id: u64,
        /// market_id -> Market metadata.
        markets: Map<u64, Market>,
        /// Sequential list of all market ids for pagination.
        market_ids: Vec<u64>,
        /// (category, index) -> market_id for category-based queries.
        category_markets: Map<(felt252, u64), u64>,
        /// category -> count of markets in that category.
        category_market_count: Map<felt252, u64>,
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
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
        MarketCreated: MarketCreated,
        BondRefunded: BondRefunded,
        MarketVoided: MarketVoided,
        VolumeIncremented: VolumeIncremented,
        UpgradeProposed: UpgradeProposed,
        UpgradeCancelled: UpgradeCancelled,
    }

    #[derive(Drop, starknet::Event)]
    pub struct MarketCreated {
        #[key]
        pub market_id: u64,
        #[key]
        pub creator: ContractAddress,
        pub condition_id: felt252,
        pub question: ByteArray,
        pub category: felt252,
        pub resolution_time: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct BondRefunded {
        #[key]
        pub market_id: u64,
        pub creator: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct MarketVoided {
        #[key]
        pub market_id: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct VolumeIncremented {
        #[key]
        pub market_id: u64,
        pub amount: u256,
        pub new_total: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct UpgradeProposed {
        pub new_class_hash: ClassHash,
        pub proposed_at: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct UpgradeCancelled {}

    // -----------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------
    pub mod Errors {
        pub const INVALID_OUTCOMES: felt252 = 'MF: need >= 2 outcomes';
        pub const INVALID_RESOLUTION_TIME: felt252 = 'MF: resolution in past';
        pub const MARKET_NOT_FOUND: felt252 = 'MF: market not found';
        pub const BOND_ALREADY_REFUNDED: felt252 = 'MF: bond already refunded';
        pub const VOLUME_BELOW_THRESHOLD: felt252 = 'MF: volume < threshold';
        pub const MARKET_NOT_RESOLVED: felt252 = 'MF: market not resolved';
        pub const VOID_TOO_EARLY: felt252 = 'MF: void grace not elapsed';
        pub const MARKET_ALREADY_VOIDED: felt252 = 'MF: already voided';
        pub const CALLER_NOT_CLOB: felt252 = 'MF: caller != CLOB';
        pub const UPGRADE_NOT_PROPOSED: felt252 = 'MF: no pending upgrade';
        pub const UPGRADE_TIMELOCK: felt252 = 'MF: timelock not elapsed';
        pub const UPGRADE_ALREADY_PENDING: felt252 = 'MF: upgrade already pending';
        pub const INVALID_MARKET_TYPE: felt252 = 'MF: invalid market type';
    }

    // -----------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------
    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        conditional_tokens: ContractAddress,
        clob_exchange: ContractAddress,
        bond_token: ContractAddress,
    ) {
        self.ownable.initializer(owner);
        self.conditional_tokens.write(conditional_tokens);
        self.clob_exchange.write(clob_exchange);
        self.bond_token.write(bond_token);
        self.next_market_id.write(1);
    }

    // -----------------------------------------------------------------
    //  Upgrade with 48-hour timelock
    //  M-4 fix: prevent re-proposal overwrite.
    //  M-5 fix: add cancel_upgrade.
    //  L-5 fix: emit events.
    // -----------------------------------------------------------------
    #[abi(embed_v0)]
    impl UpgradeTimelockImpl of super::IFactoryUpgradeTimelock<ContractState> {
        fn propose_upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            self.ownable.assert_only_owner();
            // M-4 fix: prevent overwriting a pending proposal.
            let existing = self.proposed_upgrade.read();
            assert(existing.is_zero(), Errors::UPGRADE_ALREADY_PENDING);
            let now = get_block_timestamp();
            self.proposed_upgrade.write(new_class_hash);
            self.upgrade_proposed_at.write(now);
            // L-5 fix: emit event.
            self.emit(UpgradeProposed { new_class_hash, proposed_at: now });
        }

        fn execute_upgrade(ref self: ContractState) {
            self.ownable.assert_only_owner();
            let proposed = self.proposed_upgrade.read();
            assert(proposed.is_non_zero(), Errors::UPGRADE_NOT_PROPOSED);
            let proposed_at = self.upgrade_proposed_at.read();
            let now = get_block_timestamp();
            assert(now >= proposed_at + UPGRADE_TIMELOCK_SECONDS, Errors::UPGRADE_TIMELOCK);
            self.proposed_upgrade.write(Zero::zero());
            self.upgrade_proposed_at.write(0);
            self.upgradeable.upgrade(proposed);
        }

        /// M-5 fix: cancel a pending upgrade proposal.
        fn cancel_upgrade(ref self: ContractState) {
            self.ownable.assert_only_owner();
            let proposed = self.proposed_upgrade.read();
            assert(proposed.is_non_zero(), Errors::UPGRADE_NOT_PROPOSED);
            self.proposed_upgrade.write(Zero::zero());
            self.upgrade_proposed_at.write(0);
            self.emit(UpgradeCancelled {});
        }
    }

    // -----------------------------------------------------------------
    //  IMarketFactory implementation
    // -----------------------------------------------------------------
    #[abi(embed_v0)]
    impl MarketFactoryImpl of market_zap::interfaces::i_market_factory::IMarketFactory<
        ContractState,
    > {
        fn create_market(
            ref self: ContractState,
            question: ByteArray,
            outcomes: Span<felt252>,
            category: felt252,
            collateral_token: ContractAddress,
            resolution_time: u64,
            oracle: ContractAddress,
            market_type: u8,
        ) -> u64 {
            let outcome_count: u32 = outcomes.len();
            assert(outcome_count >= 2, Errors::INVALID_OUTCOMES);
            assert(market_type <= 1, Errors::INVALID_MARKET_TYPE);

            let now = get_block_timestamp();
            assert(resolution_time > now, Errors::INVALID_RESOLUTION_TIME);

            let caller = get_caller_address();

            // Collect bond from creator in USDC (bond_token), regardless of
            // which collateral token the market uses.
            let bond_token_addr = self.bond_token.read();
            let bond_erc20 = IERC20Dispatcher { contract_address: bond_token_addr };
            // M-6 fix: assert ERC20 transfer_from succeeds.
            assert(
                bond_erc20.transfer_from(caller, get_contract_address(), BOND_AMOUNT),
                'MF: bond transfer failed',
            );

            // Compute question hash for compact storage.
            let mut serialized: Array<felt252> = array![];
            question.serialize(ref serialized);
            let mut hasher = PoseidonTrait::new();
            let mut i: u32 = 0;
            while i < serialized.len() {
                hasher = hasher.update(*serialized.at(i));
                i += 1;
            };
            let question_hash = hasher.finalize();

            // Prepare the condition on ConditionalTokens.
            let ct = IConditionalTokensDispatcher {
                contract_address: self.conditional_tokens.read(),
            };
            let condition_id = ct.prepare_condition(oracle, question_hash, outcome_count);

            // Allocate market id.
            let market_id = self.next_market_id.read();
            self.next_market_id.write(market_id + 1);

            let market = Market {
                market_id,
                creator: caller,
                condition_id,
                collateral_token,
                question_hash,
                category,
                outcome_count,
                created_at: now,
                resolution_time,
                bond_refunded: false,
                voided: false,
                volume: 0,
                market_type,
            };

            self.markets.write(market_id, market);
            self.market_ids.push(market_id);

            // Index by category.
            let cat_count = self.category_market_count.read(category);
            self.category_markets.write((category, cat_count), market_id);
            self.category_market_count.write(category, cat_count + 1);

            self
                .emit(
                    MarketCreated {
                        market_id,
                        creator: caller,
                        condition_id,
                        question,
                        category,
                        resolution_time,
                    },
                );

            market_id
        }

        /// H-1 fix: requires market to be resolved or voided before bond refund.
        fn refund_bond(ref self: ContractState, market_id: u64) {
            let mut market = self.markets.read(market_id);
            assert(!market.creator.is_zero(), Errors::MARKET_NOT_FOUND);
            assert(!market.bond_refunded, Errors::BOND_ALREADY_REFUNDED);
            assert(market.volume >= VOLUME_THRESHOLD, Errors::VOLUME_BELOW_THRESHOLD);

            // H-1 fix: check that the market's condition is resolved on-chain.
            // Cross-contract call to ConditionalTokens to verify resolution.
            let ct = IConditionalTokensDispatcher {
                contract_address: self.conditional_tokens.read(),
            };
            let condition_view = ct.get_condition(market.condition_id);
            assert(condition_view.resolved || market.voided, Errors::MARKET_NOT_RESOLVED);

            market.bond_refunded = true;
            self.markets.write(market_id, market);

            // Transfer bond back to creator (in bond_token = USDC).
            let bond_token_addr = self.bond_token.read();
            let bond_erc20 = IERC20Dispatcher { contract_address: bond_token_addr };
            // M-6 fix: assert ERC20 transfer succeeds.
            assert(
                bond_erc20.transfer(market.creator, BOND_AMOUNT),
                'MF: bond refund failed',
            );

            self.emit(BondRefunded { market_id, creator: market.creator, amount: BOND_AMOUNT });
        }

        /// H-5 fix: returns bond to creator on void (market is already penalized).
        fn void_market(ref self: ContractState, market_id: u64) {
            let mut market = self.markets.read(market_id);
            assert(!market.creator.is_zero(), Errors::MARKET_NOT_FOUND);
            assert(!market.voided, Errors::MARKET_ALREADY_VOIDED);

            let now = get_block_timestamp();
            assert(now >= market.resolution_time + VOID_GRACE_PERIOD, Errors::VOID_TOO_EARLY);

            market.voided = true;
            self.markets.write(market_id, market);

            // H-5 fix: return bond to creator if not already refunded.
            // Voiding is already a penalty (traders get equal split, not full payout).
            if !market.bond_refunded {
                let mut updated = self.markets.read(market_id);
                updated.bond_refunded = true;
                self.markets.write(market_id, updated);

                let bond_token_addr = self.bond_token.read();
                let bond_erc20 = IERC20Dispatcher { contract_address: bond_token_addr };
                assert(
                    bond_erc20.transfer(market.creator, BOND_AMOUNT),
                    'MF: void bond return failed',
                );

                self.emit(BondRefunded { market_id, creator: market.creator, amount: BOND_AMOUNT });
            }

            self.emit(MarketVoided { market_id });
        }

        /// L-4 fix: removed dead set_clob_exchange (constructor already sets it).
        /// Owner can now update CLOB exchange address if needed.
        fn set_clob_exchange(ref self: ContractState, clob_exchange: ContractAddress) {
            self.ownable.assert_only_owner();
            assert(!clob_exchange.is_zero(), 'MF: zero address');
            self.clob_exchange.write(clob_exchange);
        }

        fn increment_volume(ref self: ContractState, market_id: u64, amount: u256) {
            // Only the CLOB exchange can increment volume.
            let caller = get_caller_address();
            assert(caller == self.clob_exchange.read(), Errors::CALLER_NOT_CLOB);

            let mut market = self.markets.read(market_id);
            assert(!market.creator.is_zero(), Errors::MARKET_NOT_FOUND);

            market.volume = market.volume + amount;
            self.markets.write(market_id, market);

            self.emit(VolumeIncremented { market_id, amount, new_total: market.volume });
        }

        // -----------------------------------------------------------------
        //  Views
        // -----------------------------------------------------------------
        fn get_market(self: @ContractState, market_id: u64) -> Market {
            let market = self.markets.read(market_id);
            assert(!market.creator.is_zero(), Errors::MARKET_NOT_FOUND);
            market
        }

        fn get_markets_paginated(
            self: @ContractState,
            offset: u64,
            limit: u64,
        ) -> Span<Market> {
            let total = self.market_ids.len();
            let capped_limit = if limit > MAX_PAGE_SIZE {
                MAX_PAGE_SIZE
            } else {
                limit
            };

            let mut result: Array<Market> = array![];
            let mut i: u64 = 0;
            while i < capped_limit {
                let idx = offset + i;
                if idx >= total {
                    break;
                }
                let mid = self.market_ids.at(idx).read();
                result.append(self.markets.read(mid));
                i += 1;
            };

            result.span()
        }

        fn get_markets_by_category(
            self: @ContractState,
            category: felt252,
            limit: u64,
        ) -> Span<Market> {
            let total = self.category_market_count.read(category);
            let capped_limit = if limit > MAX_PAGE_SIZE {
                MAX_PAGE_SIZE
            } else {
                limit
            };

            let mut result: Array<Market> = array![];
            let mut i: u64 = 0;
            while i < capped_limit {
                if i >= total {
                    break;
                }
                let mid = self.category_markets.read((category, i));
                result.append(self.markets.read(mid));
                i += 1;
            };

            result.span()
        }
    }
}

// -----------------------------------------------------------------
//  Upgrade timelock interface (contract-local)
//  M-5 fix: added cancel_upgrade.
// -----------------------------------------------------------------
use starknet::class_hash::ClassHash;

#[starknet::interface]
pub trait IFactoryUpgradeTimelock<TContractState> {
    fn propose_upgrade(ref self: TContractState, new_class_hash: ClassHash);
    fn execute_upgrade(ref self: TContractState);
    fn cancel_upgrade(ref self: TContractState);
}
