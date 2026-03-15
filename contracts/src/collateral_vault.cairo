/// CollateralVault -- Multi-token escrow vault for Market-Zap.
///
/// Holds collateral on behalf of the ConditionalTokens contract.
/// Uses actual-received accounting (balanceAfter - balanceBefore) to
/// correctly handle fee-on-transfer or rebasing tokens.
/// Protected by ReentrancyGuard on deposit/withdraw.

#[starknet::contract]
pub mod CollateralVault {
    // -----------------------------------------------------------------
    //  Imports
    // -----------------------------------------------------------------
    use core::num::traits::Zero;
    use starknet::{
        ContractAddress, get_caller_address, get_contract_address, get_block_timestamp,
        storage::{Map, StorageMapReadAccess, StorageMapWriteAccess},
    };
    use starknet::storage::StoragePointerReadAccess;
    use starknet::storage::StoragePointerWriteAccess;

    use openzeppelin_access::ownable::OwnableComponent;
    use openzeppelin_security::reentrancyguard::ReentrancyGuardComponent;
    use openzeppelin_upgrades::UpgradeableComponent;
    use openzeppelin_interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::class_hash::ClassHash;

    // -----------------------------------------------------------------
    //  Components
    // -----------------------------------------------------------------
    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(
        path: ReentrancyGuardComponent, storage: reentrancy_guard, event: ReentrancyGuardEvent,
    );
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);

    #[abi(embed_v0)]
    impl OwnableMixinImpl = OwnableComponent::OwnableMixinImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;

    impl ReentrancyGuardInternalImpl = ReentrancyGuardComponent::InternalImpl<ContractState>;

    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    // -----------------------------------------------------------------
    //  Constants
    // -----------------------------------------------------------------
    const UPGRADE_TIMELOCK_SECONDS: u64 = 48 * 60 * 60; // 48 hours

    // -----------------------------------------------------------------
    //  Storage
    // -----------------------------------------------------------------
    #[storage]
    struct Storage {
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        reentrancy_guard: ReentrancyGuardComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        /// The ConditionalTokens contract address -- the only caller
        /// allowed to deposit/withdraw.
        conditional_tokens: ContractAddress,
        /// token_address -> bool  (whitelist).
        supported_tokens: Map<ContractAddress, bool>,
        /// (token, condition_id) -> collateral balance held.
        condition_balances: Map<(ContractAddress, felt252), u256>,
        /// M-7 fix: token -> aggregate balance across all conditions.
        token_total_balance: Map<ContractAddress, u256>,
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
        ReentrancyGuardEvent: ReentrancyGuardComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
        Deposited: Deposited,
        Withdrawn: Withdrawn,
        TokenAdded: TokenAdded,
        TokenRemoved: TokenRemoved,
        UpgradeProposed: UpgradeProposed,
        UpgradeCancelled: UpgradeCancelled,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Deposited {
        #[key]
        pub token: ContractAddress,
        #[key]
        pub condition_id: felt252,
        pub from: ContractAddress,
        pub requested_amount: u256,
        pub actual_received: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Withdrawn {
        #[key]
        pub token: ContractAddress,
        #[key]
        pub condition_id: felt252,
        pub to: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct TokenAdded {
        pub token: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct TokenRemoved {
        pub token: ContractAddress,
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
        pub const CALLER_NOT_CT: felt252 = 'Vault: caller != CT';
        pub const TOKEN_NOT_SUPPORTED: felt252 = 'Vault: token not supported';
        pub const ZERO_AMOUNT: felt252 = 'Vault: zero amount';
        pub const INSUFFICIENT_BALANCE: felt252 = 'Vault: insufficient balance';
        pub const ZERO_RECEIVED: felt252 = 'Vault: zero received';
        pub const UPGRADE_NOT_PROPOSED: felt252 = 'Vault: no pending upgrade';
        pub const UPGRADE_TIMELOCK: felt252 = 'Vault: timelock not elapsed';
        pub const UPGRADE_ALREADY_PENDING: felt252 = 'Vault: upgrade pending';
        pub const TOKEN_HAS_BALANCE: felt252 = 'Vault: token has active balance';
    }

    // -----------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------
    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        conditional_tokens: ContractAddress,
    ) {
        self.ownable.initializer(owner);
        self.conditional_tokens.write(conditional_tokens);
    }

    // -----------------------------------------------------------------
    //  Access modifier
    // -----------------------------------------------------------------
    #[generate_trait]
    impl AccessImpl of AccessTrait {
        fn assert_only_conditional_tokens(self: @ContractState) {
            let caller = get_caller_address();
            assert(caller == self.conditional_tokens.read(), Errors::CALLER_NOT_CT);
        }
    }

    // -----------------------------------------------------------------
    //  Upgrade with 48-hour timelock
    //  M-4 fix: prevent re-proposal overwrite.
    //  M-5 fix: add cancel_upgrade.
    //  L-5 fix: emit events for propose/cancel.
    // -----------------------------------------------------------------
    #[abi(embed_v0)]
    impl UpgradeTimelockImpl of super::IVaultUpgradeTimelock<ContractState> {
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
    //  ICollateralVault implementation
    // -----------------------------------------------------------------
    #[abi(embed_v0)]
    impl CollateralVaultImpl of market_zap::interfaces::i_collateral_vault::ICollateralVault<
        ContractState,
    > {
        /// C-3 fix: returns actual_received so ConditionalTokens can mint correctly.
        fn deposit(
            ref self: ContractState,
            token: ContractAddress,
            condition_id: felt252,
            from: ContractAddress,
            amount: u256,
        ) -> u256 {
            self.reentrancy_guard.start();
            self.assert_only_conditional_tokens();
            assert(self.supported_tokens.read(token), Errors::TOKEN_NOT_SUPPORTED);
            assert(amount > 0, Errors::ZERO_AMOUNT);

            let erc20 = IERC20Dispatcher { contract_address: token };
            let this = get_contract_address();

            // Actual-received accounting.
            let balance_before = erc20.balance_of(this);
            // M-6 fix: assert ERC20 transfer_from succeeds.
            assert(erc20.transfer_from(from, this, amount), 'Vault: transfer_from failed');
            let balance_after = erc20.balance_of(this);
            let actual_received = balance_after - balance_before;
            assert(actual_received > 0, Errors::ZERO_RECEIVED);

            // Credit condition balance.
            let current = self.condition_balances.read((token, condition_id));
            self.condition_balances.write((token, condition_id), current + actual_received);

            // M-7 fix: track aggregate token balance.
            let total = self.token_total_balance.read(token);
            self.token_total_balance.write(token, total + actual_received);

            self
                .emit(
                    Deposited {
                        token,
                        condition_id,
                        from,
                        requested_amount: amount,
                        actual_received,
                    },
                );
            self.reentrancy_guard.end();

            actual_received
        }

        fn withdraw(
            ref self: ContractState,
            token: ContractAddress,
            condition_id: felt252,
            to: ContractAddress,
            amount: u256,
        ) {
            self.reentrancy_guard.start();
            self.assert_only_conditional_tokens();
            assert(amount > 0, Errors::ZERO_AMOUNT);

            // Check & update balance (checks-effects-interactions).
            let current = self.condition_balances.read((token, condition_id));
            assert(current >= amount, Errors::INSUFFICIENT_BALANCE);
            self.condition_balances.write((token, condition_id), current - amount);

            // M-7 fix: decrement aggregate token balance.
            let total = self.token_total_balance.read(token);
            self.token_total_balance.write(token, total - amount);

            // Transfer out.
            let erc20 = IERC20Dispatcher { contract_address: token };
            // M-6 fix: assert ERC20 transfer succeeds.
            assert(erc20.transfer(to, amount), 'Vault: transfer failed');

            self.emit(Withdrawn { token, condition_id, to, amount });
            self.reentrancy_guard.end();
        }

        fn set_conditional_tokens(ref self: ContractState, ct: ContractAddress) {
            self.ownable.assert_only_owner();
            // One-time setter: only works when current value is the dummy 0x1.
            let current: felt252 = self.conditional_tokens.read().into();
            assert(current == 1, 'Vault: CT already set');
            assert(!ct.is_zero(), 'Vault: zero CT address');
            self.conditional_tokens.write(ct);
        }

        fn add_supported_token(ref self: ContractState, token: ContractAddress) {
            self.ownable.assert_only_owner();
            self.supported_tokens.write(token, true);
            self.emit(TokenAdded { token });
        }

        fn remove_supported_token(ref self: ContractState, token: ContractAddress) {
            self.ownable.assert_only_owner();
            // M-7 fix: prevent removal while conditions hold active balances.
            let total = self.token_total_balance.read(token);
            assert(total == 0, Errors::TOKEN_HAS_BALANCE);
            self.supported_tokens.write(token, false);
            self.emit(TokenRemoved { token });
        }

        fn is_supported(self: @ContractState, token: ContractAddress) -> bool {
            self.supported_tokens.read(token)
        }

        fn get_condition_balance(
            self: @ContractState,
            token: ContractAddress,
            condition_id: felt252,
        ) -> u256 {
            self.condition_balances.read((token, condition_id))
        }
    }
}

// -----------------------------------------------------------------
//  Upgrade timelock interface (contract-local)
//  M-5 fix: added cancel_upgrade.
// -----------------------------------------------------------------
use starknet::class_hash::ClassHash;

#[starknet::interface]
pub trait IVaultUpgradeTimelock<TContractState> {
    fn propose_upgrade(ref self: TContractState, new_class_hash: ClassHash);
    fn execute_upgrade(ref self: TContractState);
    fn cancel_upgrade(ref self: TContractState);
}
