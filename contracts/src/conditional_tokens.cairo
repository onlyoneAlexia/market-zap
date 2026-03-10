/// ConditionalTokens -- ERC-1155 outcome token contract for Market-Zap.
///
/// Each "condition" represents a question with N mutually-exclusive outcomes.
/// Splitting deposits collateral and mints a full set of outcome tokens;
/// merging burns a full set and returns collateral; redeeming burns winning
/// tokens after resolution and pays out proportional collateral.

#[starknet::contract]
pub mod ConditionalTokens {
    // -----------------------------------------------------------------
    //  Imports
    // -----------------------------------------------------------------
    use core::hash::HashStateTrait;
    use core::num::traits::Zero;
    use core::poseidon::PoseidonTrait;
    use starknet::{
        ContractAddress, get_caller_address, get_block_timestamp,
        storage::{Map, StorageMapReadAccess, StorageMapWriteAccess},
    };
    use starknet::storage::StoragePointerReadAccess;
    use starknet::storage::StoragePointerWriteAccess;

    use openzeppelin_token::erc1155::{ERC1155Component, ERC1155HooksEmptyImpl, ERC1155TokenURIDefaultImpl};
    use openzeppelin_access::ownable::OwnableComponent;
    use openzeppelin_upgrades::UpgradeableComponent;
    use openzeppelin_introspection::src5::SRC5Component;
    use starknet::class_hash::ClassHash;

    use market_zap::interfaces::i_conditional_tokens::{Condition, ConditionView};
    use market_zap::interfaces::i_collateral_vault::{
        ICollateralVaultDispatcher, ICollateralVaultDispatcherTrait,
    };

    // -----------------------------------------------------------------
    //  Components
    // -----------------------------------------------------------------
    component!(path: ERC1155Component, storage: erc1155, event: ERC1155Event);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);
    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);

    // ERC1155 mixins (exposes external entry-points for balanceOf, etc.)
    #[abi(embed_v0)]
    impl ERC1155MixinImpl = ERC1155Component::ERC1155MixinImpl<ContractState>;
    impl ERC1155InternalImpl = ERC1155Component::InternalImpl<ContractState>;

    #[abi(embed_v0)]
    impl OwnableMixinImpl = OwnableComponent::OwnableMixinImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;

    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    // -----------------------------------------------------------------
    //  Constants
    // -----------------------------------------------------------------
    /// Maximum number of outcomes per condition.
    const MAX_OUTCOMES: u32 = 256;

    // -----------------------------------------------------------------
    //  Storage
    // -----------------------------------------------------------------
    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc1155: ERC1155Component::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        /// Vault contract address.
        vault: ContractAddress,
        /// condition_id -> Condition metadata.
        conditions: Map<felt252, Condition>,
        /// (condition_id, outcome_index) -> payout numerator (set on resolution).
        payout_numerators: Map<(felt252, u32), u256>,
        /// Payout denominator for a condition (sum of numerators).
        payout_denominators: Map<felt252, u256>,
        /// (condition_id) -> collateral_token used at split.
        condition_collateral: Map<felt252, ContractAddress>,
        /// Upgrade timelock: proposed class hash.
        proposed_upgrade: ClassHash,
        /// Upgrade timelock: timestamp when upgrade was proposed.
        upgrade_proposed_at: u64,
    }

    // -----------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------
    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        #[flat]
        ERC1155Event: ERC1155Component::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
        ConditionPrepared: ConditionPrepared,
        PositionSplit: PositionSplit,
        PositionMerged: PositionMerged,
        PositionRedeemed: PositionRedeemed,
        PayoutsReported: PayoutsReported,
        UpgradeProposed: UpgradeProposed,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ConditionPrepared {
        #[key]
        pub condition_id: felt252,
        pub oracle: ContractAddress,
        pub question_id: felt252,
        pub outcome_count: u32,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PositionSplit {
        #[key]
        pub condition_id: felt252,
        #[key]
        pub user: ContractAddress,
        pub collateral_token: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PositionMerged {
        #[key]
        pub condition_id: felt252,
        #[key]
        pub user: ContractAddress,
        pub collateral_token: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PositionRedeemed {
        #[key]
        pub condition_id: felt252,
        #[key]
        pub user: ContractAddress,
        pub payout: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PayoutsReported {
        #[key]
        pub condition_id: felt252,
        pub oracle: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct UpgradeProposed {
        pub new_class_hash: ClassHash,
        pub proposed_at: u64,
    }

    // -----------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------
    pub mod Errors {
        pub const INVALID_OUTCOME_COUNT: felt252 = 'CT: outcome_count < 2';
        pub const TOO_MANY_OUTCOMES: felt252 = 'CT: outcome_count > MAX';
        pub const CONDITION_EXISTS: felt252 = 'CT: condition already exists';
        pub const CONDITION_NOT_FOUND: felt252 = 'CT: condition not found';
        pub const CONDITION_NOT_RESOLVED: felt252 = 'CT: not resolved';
        pub const CONDITION_ALREADY_RESOLVED: felt252 = 'CT: already resolved';
        pub const CALLER_NOT_ORACLE: felt252 = 'CT: caller != oracle';
        pub const PAYOUT_LEN_MISMATCH: felt252 = 'CT: payout len mismatch';
        pub const ZERO_AMOUNT: felt252 = 'CT: amount is zero';
        pub const ZERO_PAYOUT: felt252 = 'CT: nothing to redeem';
        pub const ZERO_DENOMINATOR: felt252 = 'CT: zero payout denominator';
        pub const COLLATERAL_MISMATCH: felt252 = 'CT: collateral mismatch';
        pub const UPGRADE_NOT_PROPOSED: felt252 = 'CT: no pending upgrade';
        pub const UPGRADE_TIMELOCK: felt252 = 'CT: timelock not elapsed';
    }

    // -----------------------------------------------------------------
    //  Internal helper (module-level for accessibility)
    // -----------------------------------------------------------------
    /// token_id = poseidon(condition_id, outcome_index), cast to u256.
    fn compute_token_id(condition_id: felt252, outcome_index: u32) -> u256 {
        let hash = PoseidonTrait::new()
            .update(condition_id)
            .update(outcome_index.into())
            .finalize();
        hash.into()
    }

    // -----------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------
    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        vault: ContractAddress,
        uri: ByteArray,
    ) {
        self.ownable.initializer(owner);
        self.erc1155.initializer(uri);
        self.vault.write(vault);
    }

    // -----------------------------------------------------------------
    //  Upgrade with 48-hour timelock
    // -----------------------------------------------------------------
    const UPGRADE_TIMELOCK_SECONDS: u64 = 48 * 60 * 60; // 48 hours

    #[abi(embed_v0)]
    impl UpgradeTimelockImpl of super::IUpgradeTimelock<ContractState> {
        fn propose_upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            self.ownable.assert_only_owner();
            let now = get_block_timestamp();
            self.proposed_upgrade.write(new_class_hash);
            self.upgrade_proposed_at.write(now);
            self.emit(UpgradeProposed { new_class_hash, proposed_at: now });
        }

        fn execute_upgrade(ref self: ContractState) {
            self.ownable.assert_only_owner();
            let proposed = self.proposed_upgrade.read();
            assert(proposed.is_non_zero(), Errors::UPGRADE_NOT_PROPOSED);
            let proposed_at = self.upgrade_proposed_at.read();
            let now = get_block_timestamp();
            assert(now >= proposed_at + UPGRADE_TIMELOCK_SECONDS, Errors::UPGRADE_TIMELOCK);
            // Clear proposal.
            self.proposed_upgrade.write(Zero::zero());
            self.upgrade_proposed_at.write(0);
            self.upgradeable.upgrade(proposed);
        }
    }

    // -----------------------------------------------------------------
    //  IConditionalTokens implementation
    // -----------------------------------------------------------------
    #[abi(embed_v0)]
    impl ConditionalTokensImpl of market_zap::interfaces::i_conditional_tokens::IConditionalTokens<
        ContractState,
    > {
        fn prepare_condition(
            ref self: ContractState,
            oracle: ContractAddress,
            question_id: felt252,
            outcome_count: u32,
        ) -> felt252 {
            // Validate inputs.
            assert(outcome_count >= 2, Errors::INVALID_OUTCOME_COUNT);
            assert(outcome_count <= MAX_OUTCOMES, Errors::TOO_MANY_OUTCOMES);

            // condition_id = poseidon(caller, question_id, outcome_count)
            let caller = get_caller_address();
            let condition_id = PoseidonTrait::new()
                .update(caller.into())
                .update(question_id)
                .update(outcome_count.into())
                .finalize();

            // Must not already exist.
            let existing = self.conditions.read(condition_id);
            assert(existing.oracle.is_zero(), Errors::CONDITION_EXISTS);

            let condition = Condition {
                oracle,
                question_id,
                outcome_count,
                resolved: false,
            };
            self.conditions.write(condition_id, condition);

            self
                .emit(
                    ConditionPrepared { condition_id, oracle, question_id, outcome_count },
                );

            condition_id
        }

        fn split_position(
            ref self: ContractState,
            collateral_token: ContractAddress,
            condition_id: felt252,
            amount: u256,
        ) {
            assert(amount > 0, Errors::ZERO_AMOUNT);
            let condition = self.conditions.read(condition_id);
            assert(!condition.oracle.is_zero(), Errors::CONDITION_NOT_FOUND);
            assert(!condition.resolved, Errors::CONDITION_ALREADY_RESOLVED);

            let caller = get_caller_address();

            // Deposit collateral into the vault on behalf of the caller.
            let vault = ICollateralVaultDispatcher {
                contract_address: self.vault.read(),
            };
            vault.deposit(collateral_token, condition_id, caller, amount);

            // Enforce single collateral per condition: first split locks the token,
            // subsequent splits must use the same token.
            let existing_collateral = self.condition_collateral.read(condition_id);
            if existing_collateral.is_zero() {
                self.condition_collateral.write(condition_id, collateral_token);
            } else {
                assert(existing_collateral == collateral_token, Errors::COLLATERAL_MISMATCH);
            }

            // Mint one of each outcome token to the caller.
            let outcome_count = condition.outcome_count;
            let mut i: u32 = 0;
            while i < outcome_count {
                let token_id = compute_token_id(condition_id, i);
                self.erc1155.mint_with_acceptance_check(caller, token_id, amount, array![].span());
                i += 1;
            };

            self
                .emit(
                    PositionSplit { condition_id, user: caller, collateral_token, amount },
                );
        }

        fn merge_position(
            ref self: ContractState,
            collateral_token: ContractAddress,
            condition_id: felt252,
            amount: u256,
        ) {
            assert(amount > 0, Errors::ZERO_AMOUNT);
            let condition = self.conditions.read(condition_id);
            assert(!condition.oracle.is_zero(), Errors::CONDITION_NOT_FOUND);
            assert(!condition.resolved, Errors::CONDITION_ALREADY_RESOLVED);

            // Must use the same collateral token that was locked during split.
            let locked_collateral = self.condition_collateral.read(condition_id);
            assert(locked_collateral == collateral_token, Errors::COLLATERAL_MISMATCH);

            let caller = get_caller_address();

            // Burn one of each outcome token from the caller.
            let outcome_count = condition.outcome_count;
            let mut i: u32 = 0;
            while i < outcome_count {
                let token_id = compute_token_id(condition_id, i);
                self.erc1155.burn(caller, token_id, amount);
                i += 1;
            };

            // Withdraw collateral from the vault back to the caller.
            let vault = ICollateralVaultDispatcher {
                contract_address: self.vault.read(),
            };
            vault.withdraw(collateral_token, condition_id, caller, amount);

            self
                .emit(
                    PositionMerged { condition_id, user: caller, collateral_token, amount },
                );
        }

        fn redeem_position(
            ref self: ContractState,
            collateral_token: ContractAddress,
            condition_id: felt252,
        ) {
            let condition = self.conditions.read(condition_id);
            assert(!condition.oracle.is_zero(), Errors::CONDITION_NOT_FOUND);
            assert(condition.resolved, Errors::CONDITION_NOT_RESOLVED);

            // Must use the same collateral token that was locked during split.
            let locked_collateral = self.condition_collateral.read(condition_id);
            assert(locked_collateral == collateral_token, Errors::COLLATERAL_MISMATCH);

            let caller = get_caller_address();
            let denominator = self.payout_denominators.read(condition_id);
            let outcome_count = condition.outcome_count;

            // Calculate total payout by iterating outcomes.
            let mut total_payout: u256 = 0;
            let mut i: u32 = 0;
            while i < outcome_count {
                let token_id = compute_token_id(condition_id, i);
                let balance = self.erc1155.balance_of(caller, token_id);
                if balance > 0 {
                    let numerator = self.payout_numerators.read((condition_id, i));
                    // payout = balance * numerator / denominator
                    total_payout += (balance * numerator) / denominator;
                    // Burn all outcome tokens.
                    self.erc1155.burn(caller, token_id, balance);
                }
                i += 1;
            };

            assert(total_payout > 0, Errors::ZERO_PAYOUT);

            // Withdraw the payout from the vault.
            let vault = ICollateralVaultDispatcher {
                contract_address: self.vault.read(),
            };
            vault.withdraw(collateral_token, condition_id, caller, total_payout);

            self.emit(PositionRedeemed { condition_id, user: caller, payout: total_payout });
        }

        fn report_payouts(
            ref self: ContractState,
            condition_id: felt252,
            payout_numerators: Span<u256>,
        ) {
            let condition = self.conditions.read(condition_id);
            assert(!condition.oracle.is_zero(), Errors::CONDITION_NOT_FOUND);
            assert(!condition.resolved, Errors::CONDITION_ALREADY_RESOLVED);

            // Only the designated oracle may report.
            let caller = get_caller_address();
            assert(caller == condition.oracle, Errors::CALLER_NOT_ORACLE);
            assert(payout_numerators.len() == condition.outcome_count, Errors::PAYOUT_LEN_MISMATCH);

            // Store numerators and compute denominator.
            let mut denominator: u256 = 0;
            let mut i: u32 = 0;
            while i < condition.outcome_count {
                let num = *payout_numerators.at(i);
                self.payout_numerators.write((condition_id, i), num);
                denominator += num;
                i += 1;
            };
            // At least one outcome must have a non-zero payout, otherwise
            // redeem_position would divide by zero and lock collateral forever.
            assert(denominator > 0, Errors::ZERO_DENOMINATOR);
            self.payout_denominators.write(condition_id, denominator);

            // Mark resolved.
            let updated = Condition { resolved: true, ..condition };
            self.conditions.write(condition_id, updated);

            self.emit(PayoutsReported { condition_id, oracle: caller });
        }

        // -----------------------------------------------------------------
        //  Views
        // -----------------------------------------------------------------
        fn get_condition(self: @ContractState, condition_id: felt252) -> ConditionView {
            let condition = self.conditions.read(condition_id);
            let mut numerators: Array<u256> = array![];
            let mut i: u32 = 0;
            while i < condition.outcome_count {
                numerators.append(self.payout_numerators.read((condition_id, i)));
                i += 1;
            };

            ConditionView {
                oracle: condition.oracle,
                question_id: condition.question_id,
                outcome_count: condition.outcome_count,
                resolved: condition.resolved,
                payout_numerators: numerators.span(),
            }
        }

        fn get_position_token_id(
            self: @ContractState,
            condition_id: felt252,
            outcome_index: u32,
        ) -> u256 {
            compute_token_id(condition_id, outcome_index)
        }
    }
}

// -----------------------------------------------------------------
//  Upgrade timelock interface (contract-local)
// -----------------------------------------------------------------
use starknet::class_hash::ClassHash;

#[starknet::interface]
pub trait IUpgradeTimelock<TContractState> {
    fn propose_upgrade(ref self: TContractState, new_class_hash: ClassHash);
    fn execute_upgrade(ref self: TContractState);
}
