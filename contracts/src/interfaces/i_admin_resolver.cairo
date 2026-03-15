use starknet::ContractAddress;

/// Status of a resolution proposal.
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub enum ResolutionStatus {
    /// No proposal has been submitted yet.
    #[default]
    None,
    /// A proposal is active and within the dispute window.
    Proposed,
    /// The proposal has been finalized (dispute window elapsed).
    Finalized,
}

/// On-chain resolution proposal.
#[derive(Copy, Drop, Serde, starknet::Store)]
pub struct Proposal {
    /// The condition being resolved.
    pub condition_id: felt252,
    /// Index of the proposed winning outcome.
    pub proposed_outcome: u32,
    /// Unix timestamp when the proposal was submitted.
    pub proposed_at: u64,
    /// Duration of the dispute window in seconds.
    pub dispute_period: u64,
    /// Current status.
    pub status: ResolutionStatus,
}

#[starknet::interface]
pub trait IAdminResolver<TContractState> {
    // ----------------------------------------------------------------
    //  State-changing
    // ----------------------------------------------------------------

    /// Propose the winning outcome for a condition.
    /// Admin only.  Can only be called after the market's
    /// resolution_time has passed (verified via MarketFactory).
    fn propose_outcome(
        ref self: TContractState,
        market_id: u64,
        condition_id: felt252,
        proposed_outcome: u32,
    );

    /// Finalize a proposal after the dispute period has elapsed.
    /// Anyone may call.  Reports payouts to ConditionalTokens.
    fn finalize_resolution(ref self: TContractState, market_id: u64, condition_id: felt252);

    /// Override an existing proposal during the dispute window.
    /// Admin only.  Resets the dispute timer.
    fn override_proposal(
        ref self: TContractState,
        condition_id: felt252,
        new_outcome: u32,
    );

    /// Resolve a voided market with equal-split payouts.
    /// Permissionless: anyone can call, but market must be voided on MarketFactory.
    fn void_resolve(ref self: TContractState, market_id: u64, condition_id: felt252);

    /// Admin: update the default dispute period (in seconds).
    fn set_dispute_period(ref self: TContractState, new_period: u64);

    /// Admin: update the configurable min/max dispute period bounds.
    /// new_min must be >= 60s (hard safety floor). new_min must be <= new_max.
    fn set_dispute_bounds(ref self: TContractState, new_min: u64, new_max: u64);

    /// Transfer admin role to a new address.
    fn transfer_admin(ref self: TContractState, new_admin: ContractAddress);

    // ----------------------------------------------------------------
    //  Views
    // ----------------------------------------------------------------

    /// Get the current proposal for a condition.
    fn get_proposal(self: @TContractState, condition_id: felt252) -> Proposal;

    /// Current dispute period setting (seconds).
    fn get_dispute_period(self: @TContractState) -> u64;

    /// Current min/max dispute period bounds (seconds).
    fn get_dispute_bounds(self: @TContractState) -> (u64, u64);

    /// Current admin address.
    fn get_admin(self: @TContractState) -> ContractAddress;
}
