/// Tests for MarketFactory contract.

use snforge_std::{
    declare, ContractClassTrait, DeclareResultTrait,
    cheat_caller_address, cheat_block_timestamp, CheatSpan,
};
use starknet::{ContractAddress, contract_address_const};

use market_zap::interfaces::i_market_factory::{
    IMarketFactoryDispatcher, IMarketFactoryDispatcherTrait,
};
use market_zap::interfaces::i_conditional_tokens::{
    IConditionalTokensDispatcher, IConditionalTokensDispatcherTrait,
};
use openzeppelin_interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use market_zap::mocks::mock_erc20::{IMockERC20Dispatcher, IMockERC20DispatcherTrait};

// -----------------------------------------------------------------
//  Helpers
// -----------------------------------------------------------------

fn OWNER() -> ContractAddress {
    contract_address_const::<'owner'>()
}

fn CLOB_EXCHANGE() -> ContractAddress {
    contract_address_const::<'clob_exchange'>()
}

fn CREATOR() -> ContractAddress {
    contract_address_const::<'creator'>()
}

fn ORACLE() -> ContractAddress {
    contract_address_const::<'oracle'>()
}

fn RANDOM() -> ContractAddress {
    contract_address_const::<'random'>()
}

/// Deploy the full stack needed for MarketFactory tests.
/// Returns (factory_addr, ct_addr, token_addr).
fn setup() -> (ContractAddress, ContractAddress, ContractAddress) {
    let vault_class = declare("CollateralVault").unwrap().contract_class();
    let ct_class = declare("ConditionalTokens").unwrap().contract_class();
    let factory_class = declare("MarketFactory").unwrap().contract_class();
    let erc20_class = declare("MockERC20").unwrap().contract_class();

    // Deploy mock ERC20
    let (token_addr, _) = erc20_class.deploy(@array![]).unwrap();

    // Deploy vault (dummy CT first)
    let dummy_ct = contract_address_const::<0x1>();
    let mut vault_cd: Array<felt252> = array![];
    OWNER().serialize(ref vault_cd);
    dummy_ct.serialize(ref vault_cd);
    let (vault_addr, _) = vault_class.deploy(@vault_cd).unwrap();

    // Deploy CT
    let mut ct_cd: Array<felt252> = array![];
    OWNER().serialize(ref ct_cd);
    vault_addr.serialize(ref ct_cd);
    let uri: ByteArray = "";
    uri.serialize(ref ct_cd);
    let (ct_addr, _) = ct_class.deploy(@ct_cd).unwrap();

    // Deploy factory (needs CT + CLOB exchange + bond_token addresses)
    let mut factory_cd: Array<felt252> = array![];
    OWNER().serialize(ref factory_cd);
    ct_addr.serialize(ref factory_cd);
    CLOB_EXCHANGE().serialize(ref factory_cd);
    token_addr.serialize(ref factory_cd); // bond_token = same ERC20 for tests
    let (factory_addr, _) = factory_class.deploy(@factory_cd).unwrap();

    (factory_addr, ct_addr, token_addr)
}

/// Mint tokens to creator, approve factory, and create a market.
fn create_test_market(
    factory_addr: ContractAddress,
    token_addr: ContractAddress,
) -> u64 {
    let factory = IMarketFactoryDispatcher { contract_address: factory_addr };
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    // Mint bond amount to creator (20 USDC = 20_000_000 with 6 decimals)
    mock.mint(CREATOR(), 20_000_000);

    // Approve factory to spend bond
    cheat_caller_address(token_addr, CREATOR(), CheatSpan::TargetCalls(1));
    erc20.approve(factory_addr, 20_000_000);

    // Create market with future resolution time
    cheat_block_timestamp(factory_addr, 1000, CheatSpan::TargetCalls(1));
    cheat_caller_address(factory_addr, CREATOR(), CheatSpan::TargetCalls(1));
    let outcomes: Array<felt252> = array!['yes', 'no'];
    factory.create_market(
        "Will BTC hit 100k?",
        outcomes.span(),
        'crypto',
        token_addr,
        2000, // resolution_time in the future
        ORACLE(),
        0, // market_type: public
    )
}

// -----------------------------------------------------------------
//  Tests: Market creation
// -----------------------------------------------------------------

#[test]
fn test_create_market() {
    let (factory_addr, _, token_addr) = setup();
    let factory = IMarketFactoryDispatcher { contract_address: factory_addr };

    let market_id = create_test_market(factory_addr, token_addr);
    assert(market_id == 1, 'first market should be id 1');

    let market = factory.get_market(market_id);
    assert(market.creator == CREATOR(), 'wrong creator');
    assert(market.outcome_count == 2, 'wrong outcome count');
    assert(market.category == 'crypto', 'wrong category');
    assert(!market.bond_refunded, 'bond should not be refunded');
    assert(!market.voided, 'should not be voided');
    assert(market.volume == 0, 'volume should be 0');
}

#[test]
#[should_panic(expected: 'MF: market not found')]
fn test_get_nonexistent_market() {
    let (factory_addr, _, _) = setup();
    let factory = IMarketFactoryDispatcher { contract_address: factory_addr };

    factory.get_market(999);
}

// -----------------------------------------------------------------
//  Tests: Volume increment
// -----------------------------------------------------------------

#[test]
fn test_increment_volume() {
    let (factory_addr, _, token_addr) = setup();
    let factory = IMarketFactoryDispatcher { contract_address: factory_addr };

    let market_id = create_test_market(factory_addr, token_addr);

    // Only CLOB exchange can increment volume
    cheat_caller_address(factory_addr, CLOB_EXCHANGE(), CheatSpan::TargetCalls(1));
    factory.increment_volume(market_id, 50_000_000);

    let market = factory.get_market(market_id);
    assert(market.volume == 50_000_000, 'volume should be 50M');
}

#[test]
#[should_panic(expected: 'MF: caller != CLOB')]
fn test_increment_volume_not_clob() {
    let (factory_addr, _, token_addr) = setup();
    let factory = IMarketFactoryDispatcher { contract_address: factory_addr };

    let market_id = create_test_market(factory_addr, token_addr);

    cheat_caller_address(factory_addr, RANDOM(), CheatSpan::TargetCalls(1));
    factory.increment_volume(market_id, 100);
}

// -----------------------------------------------------------------
//  Tests: Bond refund
// -----------------------------------------------------------------

#[test]
fn test_refund_bond_after_threshold() {
    let (factory_addr, ct_addr, token_addr) = setup();
    let factory = IMarketFactoryDispatcher { contract_address: factory_addr };
    let ct = IConditionalTokensDispatcher { contract_address: ct_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    let market_id = create_test_market(factory_addr, token_addr);

    // Increment volume past threshold ($100 = 100_000_000)
    cheat_caller_address(factory_addr, CLOB_EXCHANGE(), CheatSpan::TargetCalls(1));
    factory.increment_volume(market_id, 100_000_000);

    // H-1 fix: market must be resolved before bond refund.
    // Resolve the condition via report_payouts from the oracle.
    let market = factory.get_market(market_id);
    let payouts: Array<u256> = array![1, 0]; // outcome 0 wins
    cheat_caller_address(ct_addr, ORACLE(), CheatSpan::TargetCalls(1));
    ct.report_payouts(market.condition_id, payouts.span());

    // Refund bond
    factory.refund_bond(market_id);

    let market_after = factory.get_market(market_id);
    assert(market_after.bond_refunded, 'bond should be refunded');

    // Creator should have received their bond back
    assert(erc20.balance_of(CREATOR()) == 20_000_000, 'creator should get bond back');
}

#[test]
#[should_panic(expected: 'MF: volume < threshold')]
fn test_refund_bond_below_threshold() {
    let (factory_addr, _, token_addr) = setup();
    let factory = IMarketFactoryDispatcher { contract_address: factory_addr };

    let market_id = create_test_market(factory_addr, token_addr);

    // Volume is 0, try to refund
    factory.refund_bond(market_id);
}

#[test]
#[should_panic(expected: 'MF: bond already refunded')]
fn test_refund_bond_twice() {
    let (factory_addr, ct_addr, token_addr) = setup();
    let factory = IMarketFactoryDispatcher { contract_address: factory_addr };
    let ct = IConditionalTokensDispatcher { contract_address: ct_addr };

    let market_id = create_test_market(factory_addr, token_addr);

    cheat_caller_address(factory_addr, CLOB_EXCHANGE(), CheatSpan::TargetCalls(1));
    factory.increment_volume(market_id, 100_000_000);

    // H-1 fix: resolve condition first.
    let market = factory.get_market(market_id);
    let payouts: Array<u256> = array![1, 0];
    cheat_caller_address(ct_addr, ORACLE(), CheatSpan::TargetCalls(1));
    ct.report_payouts(market.condition_id, payouts.span());

    factory.refund_bond(market_id);
    factory.refund_bond(market_id); // Should panic
}

// -----------------------------------------------------------------
//  Tests: Void market
// -----------------------------------------------------------------

#[test]
fn test_void_market_after_grace_period() {
    let (factory_addr, _, token_addr) = setup();
    let factory = IMarketFactoryDispatcher { contract_address: factory_addr };

    let market_id = create_test_market(factory_addr, token_addr);

    // Market resolution_time = 2000, grace = 14 days = 1_209_600 seconds
    // Need timestamp >= 2000 + 1_209_600 = 1_211_600
    cheat_block_timestamp(factory_addr, 1_211_600, CheatSpan::TargetCalls(1));
    factory.void_market(market_id);

    let market = factory.get_market(market_id);
    assert(market.voided, 'should be voided');
}

#[test]
#[should_panic(expected: 'MF: void grace not elapsed')]
fn test_void_market_too_early() {
    let (factory_addr, _, token_addr) = setup();
    let factory = IMarketFactoryDispatcher { contract_address: factory_addr };

    let market_id = create_test_market(factory_addr, token_addr);

    // Try voiding right away
    cheat_block_timestamp(factory_addr, 2001, CheatSpan::TargetCalls(1));
    factory.void_market(market_id);
}

// -----------------------------------------------------------------
//  Tests: Pagination
// -----------------------------------------------------------------

#[test]
fn test_get_markets_paginated() {
    let (factory_addr, _, token_addr) = setup();
    let factory = IMarketFactoryDispatcher { contract_address: factory_addr };
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    // Create 3 markets with unique questions (avoids duplicate condition_id)
    let questions: Array<ByteArray> = array!["Q1?", "Q2?", "Q3?"];
    let mut i: u32 = 0;
    while i < 3 {
        mock.mint(CREATOR(), 20_000_000);
        cheat_caller_address(token_addr, CREATOR(), CheatSpan::TargetCalls(1));
        erc20.approve(factory_addr, 20_000_000);

        cheat_block_timestamp(factory_addr, 1000, CheatSpan::TargetCalls(1));
        cheat_caller_address(factory_addr, CREATOR(), CheatSpan::TargetCalls(1));
        let outcomes: Array<felt252> = array!['yes', 'no'];
        factory.create_market(
            questions[i].clone(),
            outcomes.span(),
            'crypto',
            token_addr,
            2000,
            ORACLE(),
            0, // market_type: public
        );
        i += 1;
    };

    // Get all markets
    let markets = factory.get_markets_paginated(0, 10);
    assert(markets.len() == 3, 'should have 3 markets');

    // Test pagination
    let page = factory.get_markets_paginated(1, 2);
    assert(page.len() == 2, 'should have 2 markets');
}

// -----------------------------------------------------------------
//  Tests: H-1 refund_bond reverts when market not resolved
// -----------------------------------------------------------------

#[test]
#[should_panic(expected: 'MF: market not resolved')]
fn test_refund_bond_before_resolution() {
    let (factory_addr, _, token_addr) = setup();
    let factory = IMarketFactoryDispatcher { contract_address: factory_addr };

    let market_id = create_test_market(factory_addr, token_addr);

    // Increment volume past threshold but do NOT resolve the condition
    cheat_caller_address(factory_addr, CLOB_EXCHANGE(), CheatSpan::TargetCalls(1));
    factory.increment_volume(market_id, 100_000_000);

    // Try to refund — should panic because condition is not resolved
    factory.refund_bond(market_id);
}

// -----------------------------------------------------------------
//  Tests: H-5 bond returned on void
// -----------------------------------------------------------------

#[test]
fn test_void_market_returns_bond() {
    let (factory_addr, _, token_addr) = setup();
    let factory = IMarketFactoryDispatcher { contract_address: factory_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    let market_id = create_test_market(factory_addr, token_addr);

    // Creator balance should be 0 (bond was taken)
    assert(erc20.balance_of(CREATOR()) == 0, 'creator should have 0');

    // Void the market after grace period
    cheat_block_timestamp(factory_addr, 1_211_600, CheatSpan::TargetCalls(1));
    factory.void_market(market_id);

    let market = factory.get_market(market_id);
    assert(market.voided, 'should be voided');
    assert(market.bond_refunded, 'bond should be refunded on void');

    // Creator should have received their bond back
    assert(erc20.balance_of(CREATOR()) == 20_000_000, 'creator gets bond on void');
}
