use starknet::ContractAddress;

/// Condition data stored on-chain.
#[derive(Copy, Drop, Serde, starknet::Store)]
pub struct Condition {
    /// The oracle/resolver that may report payouts.
    pub oracle: ContractAddress,
    /// Hash of the question text or external question identifier.
    pub question_id: felt252,
    /// Number of mutually-exclusive outcomes (e.g. 2 for binary).
    pub outcome_count: u32,
    /// Settlement status: true once `report_payouts` has been called.
    pub resolved: bool,
}

/// Full condition info returned by views (includes payout numerators).
#[derive(Drop, Serde)]
pub struct ConditionView {
    pub oracle: ContractAddress,
    pub question_id: felt252,
    pub outcome_count: u32,
    pub resolved: bool,
    /// Per-outcome payout numerators set by the oracle.
    /// Length == outcome_count; entries are zero until resolved.
    pub payout_numerators: Span<u256>,
}

#[starknet::interface]
pub trait IConditionalTokens<TContractState> {
    // ----------------------------------------------------------------
    //  State-changing
    // ----------------------------------------------------------------

    /// Register a new condition.  Anyone may call.
    /// `question_id` - external identifier for the question.
    /// `outcome_count` - number of mutually-exclusive outcomes (>= 2).
    /// Returns the deterministic `condition_id`.
    fn prepare_condition(
        ref self: TContractState,
        oracle: ContractAddress,
        question_id: felt252,
        outcome_count: u32,
    ) -> felt252;

    /// Deposit `amount` of `collateral_token` and receive one of each
    /// outcome token for the given condition.
    fn split_position(
        ref self: TContractState,
        collateral_token: ContractAddress,
        condition_id: felt252,
        amount: u256,
    );

    /// Burn one of each outcome token and withdraw `amount` collateral.
    fn merge_position(
        ref self: TContractState,
        collateral_token: ContractAddress,
        condition_id: felt252,
        amount: u256,
    );

    /// After resolution, burn winning outcome tokens and receive
    /// proportional collateral payout.
    fn redeem_position(
        ref self: TContractState,
        collateral_token: ContractAddress,
        condition_id: felt252,
    );

    /// Called by the authorized oracle/resolver to set final payouts.
    /// `payout_numerators` length must equal the condition's outcome_count.
    fn report_payouts(
        ref self: TContractState,
        condition_id: felt252,
        payout_numerators: Span<u256>,
    );

    // ----------------------------------------------------------------
    //  Views
    // ----------------------------------------------------------------

    /// Return full condition data including payout numerators.
    fn get_condition(self: @TContractState, condition_id: felt252) -> ConditionView;

    /// Deterministic token id for a (condition, outcome_index) pair.
    fn get_position_token_id(
        self: @TContractState,
        condition_id: felt252,
        outcome_index: u32,
    ) -> u256;
}
