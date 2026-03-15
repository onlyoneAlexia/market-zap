/// Tests for AdminResolver contract.

use snforge_std::{
    declare, ContractClassTrait, DeclareResultTrait,
    cheat_caller_address, cheat_block_timestamp, CheatSpan,
};
use starknet::{ContractAddress, contract_address_const};

use market_zap::interfaces::i_admin_resolver::{
    IAdminResolverDispatcher, IAdminResolverDispatcherTrait,
    ResolutionStatus,
};
use market_zap::interfaces::i_conditional_tokens::{
    IConditionalTokensDispatcher, IConditionalTokensDispatcherTrait,
};
use market_zap::interfaces::i_market_factory::Market;
use market_zap::mocks::mock_market_factory::{
    IMockMarketFactoryDispatcher, IMockMarketFactoryDispatcherTrait,
};

// -----------------------------------------------------------------
//  Helpers
// -----------------------------------------------------------------

fn ADMIN() -> ContractAddress {
    contract_address_const::<'admin'>()
}

fn NEW_ADMIN() -> ContractAddress {
    contract_address_const::<'new_admin'>()
}

fn RANDOM() -> ContractAddress {
    contract_address_const::<'random'>()
}

fn USER() -> ContractAddress {
    contract_address_const::<'user'>()
}

/// Deploy ConditionalTokens + AdminResolver + MockMarketFactory.
fn setup() -> (ContractAddress, ContractAddress, ContractAddress, ContractAddress) {
    let vault_class = declare("CollateralVault").unwrap().contract_class();
    let ct_class = declare("ConditionalTokens").unwrap().contract_class();
    let resolver_class = declare("AdminResolver").unwrap().contract_class();
    let factory_class = declare("MockMarketFactory").unwrap().contract_class();

    // Deploy vault with dummy CT
    let dummy_ct = contract_address_const::<0x1>();
    let mut vault_calldata: Array<felt252> = array![];
    ADMIN().serialize(ref vault_calldata);
    dummy_ct.serialize(ref vault_calldata);
    let (vault_addr, _) = vault_class.deploy(@vault_calldata).unwrap();

    // Deploy CT
    let mut ct_calldata: Array<felt252> = array![];
    ADMIN().serialize(ref ct_calldata);
    vault_addr.serialize(ref ct_calldata);
    let uri: ByteArray = "";
    uri.serialize(ref ct_calldata);
    let (ct_addr, _) = ct_class.deploy(@ct_calldata).unwrap();

    // Deploy MockMarketFactory
    let factory_calldata: Array<felt252> = array![];
    let (factory_addr, _) = factory_class.deploy(@factory_calldata).unwrap();

    // Deploy AdminResolver (admin, conditional_tokens, market_factory)
    let mut resolver_calldata: Array<felt252> = array![];
    ADMIN().serialize(ref resolver_calldata);
    ct_addr.serialize(ref resolver_calldata);
    factory_addr.serialize(ref resolver_calldata);
    let (resolver_addr, _) = resolver_class.deploy(@resolver_calldata).unwrap();

    (ct_addr, resolver_addr, vault_addr, factory_addr)
}

/// Prepare a binary condition on CT where the resolver is the oracle,
/// and seed a matching market in the mock factory.
fn prepare_condition_with_market(
    ct_addr: ContractAddress,
    resolver_addr: ContractAddress,
    factory_addr: ContractAddress,
    resolution_time: u64,
) -> (felt252, u64) {
    let ct = IConditionalTokensDispatcher { contract_address: ct_addr };
    cheat_caller_address(ct_addr, USER(), CheatSpan::TargetCalls(1));
    let condition_id = ct.prepare_condition(resolver_addr, 'test_question', 2);

    let market_id: u64 = 1;
    let factory = IMockMarketFactoryDispatcher { contract_address: factory_addr };
    let market = Market {
        market_id,
        creator: USER(),
        condition_id,
        collateral_token: contract_address_const::<'usdc'>(),
        question_hash: 0,
        category: 'test',
        outcome_count: 2,
        created_at: 0,
        resolution_time,
        bond_refunded: false,
        voided: false,
        volume: 0,
        market_type: 0,
    };
    factory.set_market(market);

    (condition_id, market_id)
}

// -----------------------------------------------------------------
//  Tests: Admin config
// -----------------------------------------------------------------

#[test]
fn test_default_dispute_period() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };
    assert(resolver.get_dispute_period() == 86400, 'wrong default dispute period');
}

#[test]
fn test_get_admin() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };
    assert(resolver.get_admin() == ADMIN(), 'wrong admin');
}

#[test]
fn test_set_dispute_period() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };

    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(1));
    resolver.set_dispute_period(3600);
    assert(resolver.get_dispute_period() == 3600, 'dispute period not updated');
}

#[test]
#[should_panic(expected: 'AR: caller != admin')]
fn test_set_dispute_period_not_admin() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };

    cheat_caller_address(resolver_addr, RANDOM(), CheatSpan::TargetCalls(1));
    resolver.set_dispute_period(3600);
}

#[test]
fn test_transfer_admin() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };

    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(1));
    resolver.transfer_admin(NEW_ADMIN());
    assert(resolver.get_admin() == NEW_ADMIN(), 'admin not transferred');
}

#[test]
#[should_panic(expected: 'AR: caller != admin')]
fn test_transfer_admin_not_admin() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };

    cheat_caller_address(resolver_addr, RANDOM(), CheatSpan::TargetCalls(1));
    resolver.transfer_admin(NEW_ADMIN());
}

// -----------------------------------------------------------------
//  Tests: Proposal flow
// -----------------------------------------------------------------

#[test]
fn test_propose_outcome() {
    let (ct_addr, resolver_addr, _, factory_addr) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };
    let (condition_id, market_id) = prepare_condition_with_market(ct_addr, resolver_addr, factory_addr, 50);

    cheat_block_timestamp(resolver_addr, 100, CheatSpan::TargetCalls(1));
    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(1));
    resolver.propose_outcome(market_id, condition_id, 0);

    let proposal = resolver.get_proposal(condition_id);
    assert(proposal.proposed_outcome == 0, 'wrong proposed outcome');
    assert(proposal.status == ResolutionStatus::Proposed, 'should be proposed');
}

#[test]
#[should_panic(expected: 'AR: caller != admin')]
fn test_propose_outcome_not_admin() {
    let (ct_addr, resolver_addr, _, factory_addr) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };
    let (condition_id, market_id) = prepare_condition_with_market(ct_addr, resolver_addr, factory_addr, 50);

    cheat_block_timestamp(resolver_addr, 100, CheatSpan::TargetCalls(1));
    cheat_caller_address(resolver_addr, RANDOM(), CheatSpan::TargetCalls(1));
    resolver.propose_outcome(market_id, condition_id, 0);
}

#[test]
#[should_panic(expected: 'AR: already proposed')]
fn test_propose_outcome_duplicate() {
    let (ct_addr, resolver_addr, _, factory_addr) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };
    let (condition_id, market_id) = prepare_condition_with_market(ct_addr, resolver_addr, factory_addr, 50);

    cheat_block_timestamp(resolver_addr, 100, CheatSpan::TargetCalls(2));
    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(2));
    resolver.propose_outcome(market_id, condition_id, 0);
    resolver.propose_outcome(market_id, condition_id, 1); // Should panic
}

#[test]
#[should_panic(expected: 'AR: before resolution_time')]
fn test_propose_outcome_before_resolution_time() {
    let (ct_addr, resolver_addr, _, factory_addr) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };
    let (condition_id, market_id) = prepare_condition_with_market(ct_addr, resolver_addr, factory_addr, 1000);

    cheat_block_timestamp(resolver_addr, 500, CheatSpan::TargetCalls(1));
    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(1));
    resolver.propose_outcome(market_id, condition_id, 0); // Should panic
}

// -----------------------------------------------------------------
//  Tests: Override proposal
// -----------------------------------------------------------------

#[test]
fn test_override_proposal() {
    let (ct_addr, resolver_addr, _, factory_addr) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };
    let (condition_id, market_id) = prepare_condition_with_market(ct_addr, resolver_addr, factory_addr, 50);

    cheat_block_timestamp(resolver_addr, 100, CheatSpan::TargetCalls(2));
    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(2));
    resolver.propose_outcome(market_id, condition_id, 0);
    resolver.override_proposal(condition_id, 1);

    let proposal = resolver.get_proposal(condition_id);
    assert(proposal.proposed_outcome == 1, 'should be overridden to 1');
    assert(proposal.status == ResolutionStatus::Proposed, 'should still be proposed');
}

// -----------------------------------------------------------------
//  Tests: Finalize resolution
// -----------------------------------------------------------------

#[test]
#[should_panic(expected: 'AR: dispute window open')]
fn test_finalize_too_early() {
    let (ct_addr, resolver_addr, _, factory_addr) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };
    let (condition_id, market_id) = prepare_condition_with_market(ct_addr, resolver_addr, factory_addr, 50);

    cheat_block_timestamp(resolver_addr, 100, CheatSpan::TargetCalls(1));
    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(1));
    resolver.propose_outcome(market_id, condition_id, 0);

    // Try to finalize immediately (dispute period hasn't elapsed)
    resolver.finalize_resolution(market_id, condition_id);
}

#[test]
fn test_finalize_after_dispute_period() {
    let (ct_addr, resolver_addr, _, factory_addr) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };
    let (condition_id, market_id) = prepare_condition_with_market(ct_addr, resolver_addr, factory_addr, 50);

    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(2));
    resolver.set_dispute_period(3600); // L-2 fix: must be >= MIN_DISPUTE_PERIOD (1 hour)
    cheat_block_timestamp(resolver_addr, 100, CheatSpan::TargetCalls(1));
    resolver.propose_outcome(market_id, condition_id, 1);

    // Fast-forward time past the dispute period (100 + 3600 = 3700)
    cheat_block_timestamp(resolver_addr, 3800, CheatSpan::TargetCalls(1));
    resolver.finalize_resolution(market_id, condition_id);

    let proposal = resolver.get_proposal(condition_id);
    assert(proposal.status == ResolutionStatus::Finalized, 'should be finalized');

    let ct = IConditionalTokensDispatcher { contract_address: ct_addr };
    let view = ct.get_condition(condition_id);
    assert(view.resolved, 'condition should be resolved');
}

#[test]
#[should_panic(expected: 'AR: no active proposal')]
fn test_finalize_without_proposal() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };

    resolver.finalize_resolution(999, 'nonexistent_condition');
}

// -----------------------------------------------------------------
//  Tests: L-2 dispute period bounds
// -----------------------------------------------------------------

#[test]
#[should_panic(expected: 'AR: period below minimum')]
fn test_set_dispute_period_below_minimum() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };

    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(1));
    resolver.set_dispute_period(3599); // Below default 1-hour minimum
}

#[test]
#[should_panic(expected: 'AR: period above maximum')]
fn test_set_dispute_period_above_maximum() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };

    // 30 days = 2_592_000 seconds; try 2_592_001
    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(1));
    resolver.set_dispute_period(2_592_001);
}

// -----------------------------------------------------------------
//  Tests: Configurable dispute bounds
// -----------------------------------------------------------------

#[test]
fn test_get_dispute_bounds_defaults() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };
    let (min, max) = resolver.get_dispute_bounds();
    assert(min == 3600, 'default min should be 1 hour');
    assert(max == 2_592_000, 'default max should be 30 days');
}

#[test]
fn test_set_dispute_bounds() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };

    // Lower min to 5 minutes (300s), keep max at 7 days
    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(1));
    resolver.set_dispute_bounds(300, 604_800);

    let (min, max) = resolver.get_dispute_bounds();
    assert(min == 300, 'min should be 300');
    assert(max == 604_800, 'max should be 7 days');

    // Now we can set dispute period to 5 minutes
    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(1));
    resolver.set_dispute_period(300);
    assert(resolver.get_dispute_period() == 300, 'period should be 300');
}

#[test]
#[should_panic(expected: 'AR: min below safety floor')]
fn test_set_dispute_bounds_below_safety_floor() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };

    // Try to set min below 60s absolute floor
    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(1));
    resolver.set_dispute_bounds(59, 3600);
}

#[test]
#[should_panic(expected: 'AR: min exceeds max')]
fn test_set_dispute_bounds_min_exceeds_max() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };

    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(1));
    resolver.set_dispute_bounds(7200, 3600); // min > max
}

#[test]
#[should_panic(expected: 'AR: caller != admin')]
fn test_set_dispute_bounds_not_admin() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };

    cheat_caller_address(resolver_addr, RANDOM(), CheatSpan::TargetCalls(1));
    resolver.set_dispute_bounds(300, 604_800);
}

#[test]
fn test_set_dispute_bounds_clamps_current_period() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };

    // Default period is 86400 (24h). Shrink max to 1h — period should clamp to 3600.
    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(1));
    resolver.set_dispute_bounds(60, 3600);

    assert(resolver.get_dispute_period() == 3600, 'period should clamp to new max');
}

#[test]
fn test_set_dispute_bounds_then_period_respects_new_bounds() {
    let (_, resolver_addr, _, _) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };

    // Lower bounds to allow 5-minute dispute period
    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(2));
    resolver.set_dispute_bounds(300, 604_800);
    resolver.set_dispute_period(300);

    assert(resolver.get_dispute_period() == 300, 'should allow 5min period');
}

// -----------------------------------------------------------------
//  Tests: M-1 finalize blocked on voided market
// -----------------------------------------------------------------

#[test]
#[should_panic(expected: 'AR: market is voided')]
fn test_finalize_blocked_on_voided_market() {
    let (ct_addr, resolver_addr, _, factory_addr) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };
    let factory = IMockMarketFactoryDispatcher { contract_address: factory_addr };
    let (condition_id, market_id) = prepare_condition_with_market(ct_addr, resolver_addr, factory_addr, 50);

    // Propose outcome (valid, after resolution_time)
    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(2));
    resolver.set_dispute_period(3600);
    cheat_block_timestamp(resolver_addr, 100, CheatSpan::TargetCalls(1));
    resolver.propose_outcome(market_id, condition_id, 0);

    // Now void the market in the mock factory
    let voided_market = Market {
        market_id,
        creator: USER(),
        condition_id,
        collateral_token: starknet::contract_address_const::<'usdc'>(),
        question_hash: 0,
        category: 'test',
        outcome_count: 2,
        created_at: 0,
        resolution_time: 50,
        bond_refunded: false,
        voided: true, // <-- voided
        volume: 0,
        market_type: 0,
    };
    factory.set_market(voided_market);

    // Try to finalize after dispute period — should panic because market is voided
    cheat_block_timestamp(resolver_addr, 3800, CheatSpan::TargetCalls(1));
    resolver.finalize_resolution(market_id, condition_id);
}

// -----------------------------------------------------------------
//  Tests: M-1 propose blocked on voided market
// -----------------------------------------------------------------

#[test]
#[should_panic(expected: 'AR: market is voided')]
fn test_propose_blocked_on_voided_market() {
    let (ct_addr, resolver_addr, _, factory_addr) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };
    let factory = IMockMarketFactoryDispatcher { contract_address: factory_addr };
    let (condition_id, market_id) = prepare_condition_with_market(ct_addr, resolver_addr, factory_addr, 50);

    // Void the market
    let voided_market = Market {
        market_id,
        creator: USER(),
        condition_id,
        collateral_token: starknet::contract_address_const::<'usdc'>(),
        question_hash: 0,
        category: 'test',
        outcome_count: 2,
        created_at: 0,
        resolution_time: 50,
        bond_refunded: false,
        voided: true,
        volume: 0,
        market_type: 0,
    };
    factory.set_market(voided_market);

    cheat_block_timestamp(resolver_addr, 100, CheatSpan::TargetCalls(1));
    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(1));
    resolver.propose_outcome(market_id, condition_id, 0); // Should panic
}
