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
    resolver.finalize_resolution(condition_id);
}

#[test]
fn test_finalize_after_dispute_period() {
    let (ct_addr, resolver_addr, _, factory_addr) = setup();
    let resolver = IAdminResolverDispatcher { contract_address: resolver_addr };
    let (condition_id, market_id) = prepare_condition_with_market(ct_addr, resolver_addr, factory_addr, 50);

    cheat_caller_address(resolver_addr, ADMIN(), CheatSpan::TargetCalls(2));
    resolver.set_dispute_period(100);
    cheat_block_timestamp(resolver_addr, 100, CheatSpan::TargetCalls(1));
    resolver.propose_outcome(market_id, condition_id, 1);

    // Fast-forward time past the dispute period
    cheat_block_timestamp(resolver_addr, 300, CheatSpan::TargetCalls(1));
    resolver.finalize_resolution(condition_id);

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

    resolver.finalize_resolution('nonexistent_condition');
}
