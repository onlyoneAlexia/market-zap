use starknet::ContractAddress;

/// Signed order submitted by a maker or taker.
#[derive(Copy, Drop, Serde)]
pub struct Order {
    /// The trader's address.
    pub trader: ContractAddress,
    /// Market id from MarketFactory (u128 for SNIP-12 wallet compat).
    pub market_id: u128,
    /// Outcome token id being traded.
    pub token_id: u256,
    /// true = buy outcome tokens, false = sell.
    pub is_buy: bool,
    /// Limit price in collateral units (18-decimal fixed point).
    pub price: u256,
    /// Quantity of outcome tokens.
    pub amount: u256,
    /// Unique nonce for replay protection.
    pub nonce: u256,
    /// Unix timestamp after which this order is invalid (u128 for SNIP-12 wallet compat).
    pub expiry: u128,
}

#[starknet::interface]
pub trait ICLOBExchange<TContractState> {
    // ----------------------------------------------------------------
    //  State-changing
    // ----------------------------------------------------------------

    /// Deposit collateral into the exchange for trading.
    fn deposit(ref self: TContractState, token: ContractAddress, amount: u256);

    /// Withdraw available (non-reserved) collateral.
    fn withdraw(ref self: TContractState, token: ContractAddress, amount: u256);

    /// Emergency withdraw all available balance when contract is paused.
    fn emergency_withdraw(ref self: TContractState, token: ContractAddress);

    /// Reserve a portion of a user's balance for an open order.
    /// Called internally or by an authorized operator.
    fn reserve_balance(
        ref self: TContractState,
        user: ContractAddress,
        token: ContractAddress,
        amount: u256,
        nonce: u256,
        expiry: u128,
    );

    /// Release reserved balance back to available.
    /// After expiry, this is permissionless (anyone can call).
    fn release_balance(
        ref self: TContractState,
        user: ContractAddress,
        token: ContractAddress,
        nonce: u256,
        amount: u256,
    );

    /// Settle a single maker/taker trade.
    /// Verifies ECDSA signatures, checks nonces, enforces expiry,
    /// calculates and distributes fees. Increments on-chain volume.
    fn settle_trade(
        ref self: TContractState,
        maker_order: Order,
        taker_order: Order,
        fill_amount: u256,
        maker_sig_r: felt252,
        maker_sig_s: felt252,
        taker_sig_r: felt252,
        taker_sig_s: felt252,
    );

    /// Cancel an order by marking its nonce as used.
    fn cancel_order(ref self: TContractState, nonce: u256);

    /// Set the operator address (owner-only).
    fn set_operator(ref self: TContractState, new_operator: ContractAddress);

    /// Set the fee recipient address (owner-only).
    fn set_fee_recipient(ref self: TContractState, new_fee_recipient: ContractAddress);

    /// Set fee basis points (owner-only). taker_fee_bps <= 500 (5% max).
    fn set_fees(ref self: TContractState, maker_fee_bps: u256, taker_fee_bps: u256);

    // ----------------------------------------------------------------
    //  Views
    // ----------------------------------------------------------------

    /// Available (non-reserved) balance for (user, token).
    fn get_balance(
        self: @TContractState,
        user: ContractAddress,
        token: ContractAddress,
    ) -> u256;

    /// Currently reserved balance for (user, token).
    fn get_reserved(
        self: @TContractState,
        user: ContractAddress,
        token: ContractAddress,
    ) -> u256;

    /// Whether a nonce has been consumed for a given user.
    fn is_nonce_used(
        self: @TContractState,
        user: ContractAddress,
        nonce: u256,
    ) -> bool;

    /// Contract version identifier.
    fn get_exchange_version(self: @TContractState) -> (felt252, felt252);

    /// Current fee basis points.
    fn get_fees(self: @TContractState) -> (u256, u256);

    // ----------------------------------------------------------------
    //  Dark market support
    // ----------------------------------------------------------------

    /// Register a market as a dark (private) market. Operator-only.
    /// Once registered, a market cannot be un-registered.
    fn register_dark_market(ref self: TContractState, market_id: u128);

    /// Whether a market is registered as dark.
    fn is_dark_market(self: @TContractState, market_id: u128) -> bool;

    /// Settle a dark market trade with reduced calldata.
    /// Unlike settle_trade, this does NOT take full Order structs or
    /// signatures — the operator is trusted for dark market matching.
    /// A trade_commitment hash is stored in the event for auditing.
    fn settle_dark_trade(
        ref self: TContractState,
        market_id: u128,
        token_id: u256,
        fill_amount: u256,
        execution_price: u256,
        maker: ContractAddress,
        taker: ContractAddress,
        maker_is_buy: bool,
        trade_commitment: felt252,
    );
}
