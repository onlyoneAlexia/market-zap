use starknet::ContractAddress;

#[starknet::interface]
pub trait ICollateralVault<TContractState> {
    // ----------------------------------------------------------------
    //  State-changing
    // ----------------------------------------------------------------

    /// Deposit `amount` of `token` into the vault, credited to
    /// `condition_id`.  Uses actual-received accounting
    /// (balanceAfter - balanceBefore) to handle fee-on-transfer tokens.
    /// Only callable by the ConditionalTokens contract.
    fn deposit(
        ref self: TContractState,
        token: ContractAddress,
        condition_id: felt252,
        from: ContractAddress,
        amount: u256,
    );

    /// Withdraw `amount` of `token` from the vault for `condition_id`,
    /// sending funds to `to`.
    /// Only callable by the ConditionalTokens contract.
    fn withdraw(
        ref self: TContractState,
        token: ContractAddress,
        condition_id: felt252,
        to: ContractAddress,
        amount: u256,
    );

    /// Admin: set the ConditionalTokens address (one-time, resolves
    /// circular deployment dependency).
    fn set_conditional_tokens(ref self: TContractState, ct: ContractAddress);

    /// Admin: add a token to the whitelist of supported collateral.
    fn add_supported_token(ref self: TContractState, token: ContractAddress);

    /// Admin: remove a token from the whitelist.
    fn remove_supported_token(ref self: TContractState, token: ContractAddress);

    // ----------------------------------------------------------------
    //  Views
    // ----------------------------------------------------------------

    /// Whether `token` is on the supported whitelist.
    fn is_supported(self: @TContractState, token: ContractAddress) -> bool;

    /// Collateral balance held for a specific (token, condition_id).
    fn get_condition_balance(
        self: @TContractState,
        token: ContractAddress,
        condition_id: felt252,
    ) -> u256;
}
