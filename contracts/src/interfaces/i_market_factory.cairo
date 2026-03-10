use starknet::ContractAddress;

/// On-chain market metadata.
#[derive(Copy, Drop, Serde, starknet::Store)]
pub struct Market {
    /// Unique market id (sequential).
    pub market_id: u64,
    /// Creator who posted the bond.
    pub creator: ContractAddress,
    /// Corresponding condition_id in ConditionalTokens.
    pub condition_id: felt252,
    /// Collateral token used for this market.
    pub collateral_token: ContractAddress,
    /// Question string hash (full string stored in event).
    pub question_hash: felt252,
    /// Category identifier (e.g. "crypto", "sports").
    pub category: felt252,
    /// Number of outcomes.
    pub outcome_count: u32,
    /// Unix timestamp: market creation.
    pub created_at: u64,
    /// Unix timestamp: trading closes / resolution begins.
    pub resolution_time: u64,
    /// Whether the bond has been refunded.
    pub bond_refunded: bool,
    /// Whether the market has been voided.
    pub voided: bool,
    /// Cumulative volume in collateral token units.
    pub volume: u256,
    /// Market type: 0 = public, 1 = dark/private.
    pub market_type: u8,
}

#[starknet::interface]
pub trait IMarketFactory<TContractState> {
    // ----------------------------------------------------------------
    //  State-changing
    // ----------------------------------------------------------------

    /// Create a new prediction market.
    /// Caller must have approved `bond_amount` of `collateral_token`.
    /// Returns the new `market_id`.
    fn create_market(
        ref self: TContractState,
        question: ByteArray,
        outcomes: Span<felt252>,
        category: felt252,
        collateral_token: ContractAddress,
        resolution_time: u64,
        oracle: ContractAddress,
        market_type: u8,
    ) -> u64;

    /// Refund the creator bond once volume exceeds $100 threshold.
    /// Callable by anyone, but only succeeds when volume >= threshold.
    fn refund_bond(ref self: TContractState, market_id: u64);

    /// Void a market that has been unresolved for 14 days past
    /// resolution_time. Permissionless.
    fn void_market(ref self: TContractState, market_id: u64);

    /// Increment the cumulative volume for a market.
    /// Restricted to the CLOBExchange contract.
    fn increment_volume(ref self: TContractState, market_id: u64, amount: u256);

    /// Update the CLOBExchange address. Owner-only, one-time setter
    /// to resolve circular deployment dependency.
    fn set_clob_exchange(ref self: TContractState, clob_exchange: ContractAddress);

    // ----------------------------------------------------------------
    //  Views
    // ----------------------------------------------------------------

    /// Fetch a single market by id.
    fn get_market(self: @TContractState, market_id: u64) -> Market;

    /// Paginated market listing. `offset` is 0-based, `limit` capped
    /// at 50.
    fn get_markets_paginated(
        self: @TContractState,
        offset: u64,
        limit: u64,
    ) -> Span<Market>;

    /// All markets that match `category`.  Returns up to `limit`.
    fn get_markets_by_category(
        self: @TContractState,
        category: felt252,
        limit: u64,
    ) -> Span<Market>;
}
