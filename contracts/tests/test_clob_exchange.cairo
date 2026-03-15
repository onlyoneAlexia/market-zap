/// Tests for CLOBExchange contract.

use core::hash::HashStateTrait;
use core::poseidon::PoseidonTrait;
use snforge_std::{
    declare, ContractClassTrait, DeclareResultTrait,
    cheat_caller_address, CheatSpan,
};
use starknet::{ContractAddress, contract_address_const};

use market_zap::interfaces::i_clob_exchange::{
    ICLOBExchangeDispatcher, ICLOBExchangeDispatcherTrait, Order,
};
use market_zap::interfaces::i_market_factory::Market;
use openzeppelin_interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use market_zap::mocks::mock_erc20::{IMockERC20Dispatcher, IMockERC20DispatcherTrait};
use market_zap::mocks::mock_market_factory::{
    IMockMarketFactoryDispatcher, IMockMarketFactoryDispatcherTrait,
};

// -----------------------------------------------------------------
//  Helpers
// -----------------------------------------------------------------

fn OWNER() -> ContractAddress {
    contract_address_const::<'owner'>()
}

fn OPERATOR() -> ContractAddress {
    contract_address_const::<'operator'>()
}

fn FEE_RECIPIENT() -> ContractAddress {
    contract_address_const::<'fee_recipient'>()
}

fn MARKET_FACTORY() -> ContractAddress {
    contract_address_const::<'market_factory'>()
}

fn CT_CONTRACT() -> ContractAddress {
    contract_address_const::<'ct_contract'>()
}

fn USER_A() -> ContractAddress {
    contract_address_const::<'user_a'>()
}

fn USER_B() -> ContractAddress {
    contract_address_const::<'user_b'>()
}

fn RANDOM() -> ContractAddress {
    contract_address_const::<'random'>()
}

/// Compute token_id the same way ConditionalTokens does:
/// poseidon(condition_id, outcome_index) cast to u256.
fn compute_token_id(condition_id: felt252, outcome_index: u32) -> u256 {
    let hash = PoseidonTrait::new()
        .update(condition_id)
        .update(outcome_index.into())
        .finalize();
    hash.into()
}

/// Deploy a MockAccount that always returns VALIDATED for is_valid_signature.
fn deploy_mock_account() -> ContractAddress {
    let class = declare("MockAccount").unwrap().contract_class();
    let (addr, _) = class.deploy(@array![]).unwrap();
    addr
}

fn deploy_exchange() -> ContractAddress {
    let class = declare("CLOBExchange").unwrap().contract_class();
    let mut calldata: Array<felt252> = array![];
    OWNER().serialize(ref calldata);
    MARKET_FACTORY().serialize(ref calldata);
    CT_CONTRACT().serialize(ref calldata);
    FEE_RECIPIENT().serialize(ref calldata);
    OPERATOR().serialize(ref calldata);
    let (addr, _) = class.deploy(@calldata).unwrap();
    addr
}

fn deploy_mock_erc20() -> ContractAddress {
    let class = declare("MockERC20").unwrap().contract_class();
    let calldata: Array<felt252> = array![];
    let (addr, _) = class.deploy(@calldata).unwrap();
    addr
}

fn deploy_mock_market_factory() -> ContractAddress {
    let class = declare("MockMarketFactory").unwrap().contract_class();
    let calldata: Array<felt252> = array![];
    let (addr, _) = class.deploy(@calldata).unwrap();
    addr
}

fn deploy_mock_erc1155() -> ContractAddress {
    let class = declare("MockERC1155").unwrap().contract_class();
    let calldata: Array<felt252> = array![];
    let (addr, _) = class.deploy(@calldata).unwrap();
    addr
}

/// Deploy an exchange wired to mocks so `settle_trade` can be exercised.
/// Returns (exchange_addr, token_addr, factory_addr, user_a_addr, user_b_addr).
/// user_a and user_b are MockAccount contracts that always validate signatures.
fn deploy_exchange_with_mocks(
) -> (ContractAddress, ContractAddress, ContractAddress, ContractAddress, ContractAddress) {
    let exchange_class = declare("CLOBExchange").unwrap().contract_class();
    let factory_addr = deploy_mock_market_factory();
    let erc1155_addr = deploy_mock_erc1155();
    let token_addr = deploy_mock_erc20();

    // Deploy mock accounts for signature verification (C-1 fix).
    let user_a = deploy_mock_account();
    let user_b = deploy_mock_account();

    // Seed a market in the mock factory so the exchange can resolve collateral_token.
    let factory = IMockMarketFactoryDispatcher { contract_address: factory_addr };
    let market: Market = Market {
        market_id: 1,
        creator: user_a,
        condition_id: 'cond_1',
        collateral_token: token_addr,
        question_hash: 0,
        category: 'test',
        outcome_count: 2,
        created_at: 0,
        resolution_time: 9999999,
        bond_refunded: false,
        voided: false,
        volume: 0,
        market_type: 0,
    };
    factory.set_market(market);

    // Deploy exchange with mock addresses.
    let mut calldata: Array<felt252> = array![];
    OWNER().serialize(ref calldata);
    factory_addr.serialize(ref calldata);
    erc1155_addr.serialize(ref calldata);
    FEE_RECIPIENT().serialize(ref calldata);
    OPERATOR().serialize(ref calldata);
    let (exchange_addr, _) = exchange_class.deploy(@calldata).unwrap();

    (exchange_addr, token_addr, factory_addr, user_a, user_b)
}

// -----------------------------------------------------------------
//  Tests: Cancel order / nonce management
// -----------------------------------------------------------------

#[test]
fn test_cancel_order_marks_nonce() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };

    assert(!exchange.is_nonce_used(USER_A(), 42), 'nonce should be unused');

    cheat_caller_address(exchange_addr, USER_A(), CheatSpan::TargetCalls(1));
    exchange.cancel_order(42);

    assert(exchange.is_nonce_used(USER_A(), 42), 'nonce should be used');
}

#[test]
#[should_panic(expected: 'CLOB: nonce already used')]
fn test_cancel_order_duplicate_nonce() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };

    cheat_caller_address(exchange_addr, USER_A(), CheatSpan::TargetCalls(2));
    exchange.cancel_order(42);
    exchange.cancel_order(42); // Should panic
}

#[test]
fn test_nonce_isolation_between_users() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };

    // User A cancels nonce 1
    cheat_caller_address(exchange_addr, USER_A(), CheatSpan::TargetCalls(1));
    exchange.cancel_order(1);

    // User B's nonce 1 should still be unused
    assert(exchange.is_nonce_used(USER_A(), 1), 'A nonce should be used');
    assert(!exchange.is_nonce_used(USER_B(), 1), 'B nonce should be unused');
}

// -----------------------------------------------------------------
//  Tests: Balance tracking
// -----------------------------------------------------------------

#[test]
fn test_default_balances_are_zero() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let token = deploy_mock_erc20();

    assert(exchange.get_balance(USER_A(), token) == 0, 'balance should be 0');
    assert(exchange.get_reserved(USER_A(), token) == 0, 'reserved should be 0');
}

// -----------------------------------------------------------------
//  Tests: Deposit / Withdraw
// -----------------------------------------------------------------

#[test]
fn test_deposit_and_withdraw() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let token_addr = deploy_mock_erc20();
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    // Mint tokens to user and approve exchange
    mock.mint(USER_A(), 1000);
    cheat_caller_address(token_addr, USER_A(), CheatSpan::TargetCalls(1));
    erc20.approve(exchange_addr, 500);

    // Deposit
    cheat_caller_address(exchange_addr, USER_A(), CheatSpan::TargetCalls(1));
    exchange.deposit(token_addr, 500);

    assert(exchange.get_balance(USER_A(), token_addr) == 500, 'balance after deposit');
    assert(erc20.balance_of(USER_A()) == 500, 'user token balance');

    // Withdraw
    cheat_caller_address(exchange_addr, USER_A(), CheatSpan::TargetCalls(1));
    exchange.withdraw(token_addr, 200);

    assert(exchange.get_balance(USER_A(), token_addr) == 300, 'balance after withdraw');
    assert(erc20.balance_of(USER_A()) == 700, 'user token after withdraw');
}

#[test]
#[should_panic(expected: 'CLOB: zero amount')]
fn test_deposit_zero() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let token_addr = deploy_mock_erc20();

    cheat_caller_address(exchange_addr, USER_A(), CheatSpan::TargetCalls(1));
    exchange.deposit(token_addr, 0);
}

#[test]
#[should_panic(expected: 'CLOB: insufficient balance')]
fn test_withdraw_insufficient() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let token_addr = deploy_mock_erc20();

    cheat_caller_address(exchange_addr, USER_A(), CheatSpan::TargetCalls(1));
    exchange.withdraw(token_addr, 100);
}

// -----------------------------------------------------------------
//  Tests: Reserve / Release
// -----------------------------------------------------------------

#[test]
fn test_reserve_and_release() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let token_addr = deploy_mock_erc20();
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    // Setup: deposit funds
    mock.mint(USER_A(), 1000);
    cheat_caller_address(token_addr, USER_A(), CheatSpan::TargetCalls(1));
    erc20.approve(exchange_addr, 1000);
    cheat_caller_address(exchange_addr, USER_A(), CheatSpan::TargetCalls(1));
    exchange.deposit(token_addr, 1000);

    // Operator reserves balance
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(USER_A(), token_addr, 400, 1, 9999999, 1);

    assert(exchange.get_balance(USER_A(), token_addr) == 600, 'available after reserve');
    assert(exchange.get_reserved(USER_A(), token_addr) == 400, 'reserved after reserve');

    // Operator releases balance
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.release_balance(USER_A(), token_addr, 1, 200);

    assert(exchange.get_balance(USER_A(), token_addr) == 800, 'available after release');
    assert(exchange.get_reserved(USER_A(), token_addr) == 200, 'reserved after release');
}

#[test]
#[should_panic(expected: 'CLOB: caller != operator')]
fn test_reserve_by_random_user() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let token_addr = deploy_mock_erc20();

    // Random user tries to reserve someone else's balance
    cheat_caller_address(exchange_addr, RANDOM(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(USER_A(), token_addr, 100, 1, 9999999, 1);
}

#[test]
#[should_panic(expected: 'CLOB: insufficient balance')]
fn test_reserve_more_than_available() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let token_addr = deploy_mock_erc20();

    // No balance, try to reserve
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(USER_A(), token_addr, 100, 1, 9999999, 1);
}

#[test]
#[should_panic(expected: 'CLOB: nonce already reserved')]
fn test_reserve_balance_duplicate_nonce_reverts() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let token_addr = deploy_mock_erc20();
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    // Deposit enough for two reservations.
    mock.mint(USER_A(), 2000);
    cheat_caller_address(token_addr, USER_A(), CheatSpan::TargetCalls(1));
    erc20.approve(exchange_addr, 2000);
    cheat_caller_address(exchange_addr, USER_A(), CheatSpan::TargetCalls(1));
    exchange.deposit(token_addr, 2000);

    // First reservation with nonce 1 — should succeed.
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(USER_A(), token_addr, 100, 1, 9999999, 1);

    // Second reservation with same nonce 1 — should panic.
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(USER_A(), token_addr, 200, 1, 9999999, 1);
}

// -----------------------------------------------------------------
//  Tests: Partial fills per nonce (settle_trade)
//  C-1 fix: uses MockAccount for signature verification.
//  C-4 fix: uses computed token_id from condition_id.
// -----------------------------------------------------------------

#[test]
fn test_settle_trade_partial_fill_does_not_burn_nonce() {
    let (exchange_addr, token_addr, _factory_addr, user_a, user_b) = deploy_exchange_with_mocks();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let valid_token_id = compute_token_id('cond_1', 0);

    // Fund maker (user_a) and deposit collateral.
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    mock.mint(user_a, 1000);
    cheat_caller_address(token_addr, user_a, CheatSpan::TargetCalls(1));
    erc20.approve(exchange_addr, 1000);
    cheat_caller_address(exchange_addr, user_a, CheatSpan::TargetCalls(1));
    exchange.deposit(token_addr, 1000);

    // Reserve enough for the full order cost (price=1e18 so cost==fill_amount).
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(user_a, token_addr, 100, 1, 9999999, 1);

    let maker: Order = Order {
        trader: user_a,
        market_id: 1,
        token_id: valid_token_id,
        is_buy: true,
        price: 1_000_000_000_000_000_000, // 1e18
        amount: 100,
        nonce: 1,
        expiry: 9999999,
    };

    let taker: Order = Order {
        trader: user_b,
        market_id: 1,
        token_id: valid_token_id,
        is_buy: false,
        price: 1_000_000_000_000_000_000, // 1e18
        amount: 100,
        nonce: 2,
        expiry: 9999999,
    };

    assert(!exchange.is_nonce_used(user_a, 1), 'maker nonce unused initially');
    assert(!exchange.is_nonce_used(user_b, 2), 'taker nonce unused initially');

    // First partial fill: 40/100.
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.settle_trade(maker, taker, 40, array![0, 0].span(), array![0, 0].span());

    // Nonces should NOT be burned after a partial fill.
    assert(!exchange.is_nonce_used(user_a, 1), 'maker nonce not burned');
    assert(!exchange.is_nonce_used(user_b, 2), 'taker nonce not burned');
}

#[test]
fn test_settle_trade_second_fill_burns_nonce_at_full_amount() {
    let (exchange_addr, token_addr, _factory_addr, user_a, user_b) = deploy_exchange_with_mocks();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let valid_token_id = compute_token_id('cond_1', 0);

    // Fund maker and deposit.
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    mock.mint(user_a, 1000);
    cheat_caller_address(token_addr, user_a, CheatSpan::TargetCalls(1));
    erc20.approve(exchange_addr, 1000);
    cheat_caller_address(exchange_addr, user_a, CheatSpan::TargetCalls(1));
    exchange.deposit(token_addr, 1000);

    // Reserve full cost.
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(user_a, token_addr, 100, 1, 9999999, 1);

    let maker: Order = Order {
        trader: user_a,
        market_id: 1,
        token_id: valid_token_id,
        is_buy: true,
        price: 1_000_000_000_000_000_000,
        amount: 100,
        nonce: 1,
        expiry: 9999999,
    };

    let taker: Order = Order {
        trader: user_b,
        market_id: 1,
        token_id: valid_token_id,
        is_buy: false,
        price: 1_000_000_000_000_000_000,
        amount: 100,
        nonce: 2,
        expiry: 9999999,
    };

    // Fill 40 then 60.
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(2));
    exchange.settle_trade(maker, taker, 40, array![0, 0].span(), array![0, 0].span());
    exchange.settle_trade(maker, taker, 60, array![0, 0].span(), array![0, 0].span());

    assert(exchange.is_nonce_used(user_a, 1), 'maker nonce burned full');
    assert(exchange.is_nonce_used(user_b, 2), 'taker nonce burned full');
}

#[test]
#[should_panic(expected: 'CLOB: fill > order amount')]
fn test_settle_trade_overfills_remaining_reverts() {
    let (exchange_addr, token_addr, _factory_addr, user_a, user_b) = deploy_exchange_with_mocks();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let valid_token_id = compute_token_id('cond_1', 0);

    // Fund maker and deposit + reserve.
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    mock.mint(user_a, 1000);
    cheat_caller_address(token_addr, user_a, CheatSpan::TargetCalls(1));
    erc20.approve(exchange_addr, 1000);
    cheat_caller_address(exchange_addr, user_a, CheatSpan::TargetCalls(1));
    exchange.deposit(token_addr, 1000);

    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(user_a, token_addr, 100, 1, 9999999, 1);

    let maker: Order = Order {
        trader: user_a,
        market_id: 1,
        token_id: valid_token_id,
        is_buy: true,
        price: 1_000_000_000_000_000_000,
        amount: 100,
        nonce: 1,
        expiry: 9999999,
    };
    let taker: Order = Order {
        trader: user_b,
        market_id: 1,
        token_id: valid_token_id,
        is_buy: false,
        price: 1_000_000_000_000_000_000,
        amount: 100,
        nonce: 2,
        expiry: 9999999,
    };

    // First fill 80, then attempt to fill 30 (total 110 > 100) should revert.
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(2));
    exchange.settle_trade(maker, taker, 80, array![0, 0].span(), array![0, 0].span());
    exchange.settle_trade(maker, taker, 30, array![0, 0].span(), array![0, 0].span());
}

#[test]
#[should_panic(expected: 'CLOB: order params mismatch')]
fn test_settle_trade_same_nonce_different_params_reverts() {
    let (exchange_addr, token_addr, _factory_addr, user_a, user_b) = deploy_exchange_with_mocks();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let valid_token_id = compute_token_id('cond_1', 0);

    // Fund maker and deposit + reserve.
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    mock.mint(user_a, 1000);
    cheat_caller_address(token_addr, user_a, CheatSpan::TargetCalls(1));
    erc20.approve(exchange_addr, 1000);
    cheat_caller_address(exchange_addr, user_a, CheatSpan::TargetCalls(1));
    exchange.deposit(token_addr, 1000);

    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(user_a, token_addr, 100, 1, 9999999, 1);

    let maker_ok: Order = Order {
        trader: user_a,
        market_id: 1,
        token_id: valid_token_id,
        is_buy: true,
        price: 1_000_000_000_000_000_000,
        amount: 100,
        nonce: 1,
        expiry: 9999999,
    };
    let taker_ok: Order = Order {
        trader: user_b,
        market_id: 1,
        token_id: valid_token_id,
        is_buy: false,
        price: 1_000_000_000_000_000_000,
        amount: 100,
        nonce: 2,
        expiry: 9999999,
    };

    // First fill locks hash for maker nonce=1.
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.settle_trade(maker_ok, taker_ok, 10, array![0, 0].span(), array![0, 0].span());

    // Second fill uses same nonce but different amount -> should revert.
    // (Price must still cross to pass earlier validation.)
    let maker_bad: Order = Order {
        trader: user_a,
        market_id: 1,
        token_id: valid_token_id,
        is_buy: true,
        price: 1_000_000_000_000_000_000,
        amount: 200, // different from original 100 -> different hash
        nonce: 1,
        expiry: 9999999,
    };

    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.settle_trade(maker_bad, taker_ok, 10, array![0, 0].span(), array![0, 0].span());
}

// -----------------------------------------------------------------
//  Tests: Dark market registration
// -----------------------------------------------------------------

#[test]
fn test_register_dark_market() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };

    assert(!exchange.is_dark_market(1), 'should not be dark initially');

    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.register_dark_market(1);

    assert(exchange.is_dark_market(1), 'should be dark after register');
    assert(!exchange.is_dark_market(2), 'other market should not be dark');
}

#[test]
#[should_panic(expected: 'CLOB: caller != operator')]
fn test_register_dark_market_unauthorized() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };

    cheat_caller_address(exchange_addr, RANDOM(), CheatSpan::TargetCalls(1));
    exchange.register_dark_market(1);
}

#[test]
#[should_panic(expected: 'CLOB: already dark market')]
fn test_register_dark_market_duplicate() {
    let exchange_addr = deploy_exchange();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };

    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(2));
    exchange.register_dark_market(1);
    exchange.register_dark_market(1); // should panic
}

// -----------------------------------------------------------------
//  Tests: Dark trade settlement
//  C-4 fix: uses computed token_id from condition_id.
// -----------------------------------------------------------------

/// Helper: deploy exchange with mocks and register a dark market (id=1).
fn deploy_dark_exchange_with_mocks(
) -> (ContractAddress, ContractAddress, ContractAddress, ContractAddress, ContractAddress) {
    let (exchange_addr, token_addr, factory_addr, user_a, user_b) = deploy_exchange_with_mocks();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };

    // Register market 1 as dark.
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.register_dark_market(1);

    (exchange_addr, token_addr, factory_addr, user_a, user_b)
}

#[test]
fn test_settle_dark_trade_basic() {
    let (exchange_addr, token_addr, _factory_addr, user_a, user_b) = deploy_dark_exchange_with_mocks();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };
    let valid_token_id = compute_token_id('cond_1', 0);

    // Fund maker (buyer) and deposit.
    mock.mint(user_a, 1000);
    cheat_caller_address(token_addr, user_a, CheatSpan::TargetCalls(1));
    erc20.approve(exchange_addr, 1000);
    cheat_caller_address(exchange_addr, user_a, CheatSpan::TargetCalls(1));
    exchange.deposit(token_addr, 1000);

    // Reserve maker balance for the trade.
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(user_a, token_addr, 100, 1, 9999999, 1);

    // Settle dark trade: maker buys 100 tokens at price 1e18 (cost = 100).
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.settle_dark_trade(
        1,                               // market_id
        valid_token_id,                  // token_id (C-4 fix)
        100,                             // fill_amount
        1_000_000_000_000_000_000,       // execution_price = 1e18
        user_a,                          // maker (buyer)
        user_b,                          // taker (seller)
        true,                            // maker_is_buy
        'commitment_hash',               // trade_commitment
    );

    // Verify balances: maker reserved should decrease by cost (100).
    assert(exchange.get_reserved(user_a, token_addr) == 0, 'maker reserved after');
    // Taker gets cost minus fee. Default taker fee is 100bps = 1%.
    // cost = 100, fee = 100 * 100 / 10000 = 1
    assert(exchange.get_balance(user_b, token_addr) == 99, 'taker balance after');
    // Fee recipient gets fee.
    assert(exchange.get_balance(FEE_RECIPIENT(), token_addr) == 1, 'fee recipient bal');
}

#[test]
fn test_settle_dark_trade_fee_calculation() {
    let (exchange_addr, token_addr, _factory_addr, user_a, user_b) = deploy_dark_exchange_with_mocks();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };
    let valid_token_id = compute_token_id('cond_1', 0);

    // Set custom fee: 200 bps taker fee (2%).
    cheat_caller_address(exchange_addr, OWNER(), CheatSpan::TargetCalls(1));
    exchange.set_fees(0, 200);

    // Fund and deposit.
    mock.mint(user_a, 10000);
    cheat_caller_address(token_addr, user_a, CheatSpan::TargetCalls(1));
    erc20.approve(exchange_addr, 10000);
    cheat_caller_address(exchange_addr, user_a, CheatSpan::TargetCalls(1));
    exchange.deposit(token_addr, 10000);

    // Reserve.
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(user_a, token_addr, 1000, 1, 9999999, 1);

    // Settle: maker buys, cost = 1000 * 0.5 = 500 (at 0.5e18 price).
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.settle_dark_trade(
        1,
        valid_token_id,
        1000,
        500_000_000_000_000_000, // 0.5e18
        user_a,
        user_b,
        true,
        'commitment_2',
    );

    // cost = 1000 * 500_000_000_000_000_000 / 1e18 = 500
    // fee = 500 * 200 / 10000 = 10
    assert(exchange.get_balance(user_b, token_addr) == 490, 'taker gets cost - fee');
    assert(exchange.get_balance(FEE_RECIPIENT(), token_addr) == 10, 'fee recipient gets fee');
    assert(exchange.get_reserved(user_a, token_addr) == 500, 'maker reserved minus cost');
}

#[test]
#[should_panic(expected: 'CLOB: caller != operator')]
fn test_settle_dark_trade_unauthorized() {
    let (exchange_addr, _token_addr, _factory_addr, user_a, user_b) = deploy_dark_exchange_with_mocks();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let valid_token_id = compute_token_id('cond_1', 0);

    cheat_caller_address(exchange_addr, RANDOM(), CheatSpan::TargetCalls(1));
    exchange.settle_dark_trade(
        1, valid_token_id, 100, 1_000_000_000_000_000_000,
        user_a, user_b, true, 'bad',
    );
}

#[test]
#[should_panic(expected: 'CLOB: not a dark market')]
fn test_settle_dark_trade_not_dark_market() {
    // Use deploy_exchange_with_mocks (NOT dark) — market 1 is public.
    let (exchange_addr, _token_addr, _factory_addr, user_a, user_b) = deploy_exchange_with_mocks();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let valid_token_id = compute_token_id('cond_1', 0);

    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.settle_dark_trade(
        1, valid_token_id, 100, 1_000_000_000_000_000_000,
        user_a, user_b, true, 'fail',
    );
}

// -----------------------------------------------------------------
//  Tests: C-1 invalid signature reverts
// -----------------------------------------------------------------

/// Deploy a MockBadAccount that always rejects signatures.
fn deploy_mock_bad_account() -> ContractAddress {
    let class = declare("MockBadAccount").unwrap().contract_class();
    let (addr, _) = class.deploy(@array![]).unwrap();
    addr
}

#[test]
#[should_panic(expected: 'CLOB: invalid signature')]
fn test_settle_trade_invalid_maker_signature_reverts() {
    // Deploy exchange with bad account as maker, good account as taker.
    let exchange_class = declare("CLOBExchange").unwrap().contract_class();
    let factory_addr = deploy_mock_market_factory();
    let erc1155_addr = deploy_mock_erc1155();
    let token_addr = deploy_mock_erc20();

    let bad_maker = deploy_mock_bad_account(); // Always rejects signatures
    let good_taker = deploy_mock_account();    // Always validates

    let factory = IMockMarketFactoryDispatcher { contract_address: factory_addr };
    let market: Market = Market {
        market_id: 1, creator: bad_maker, condition_id: 'cond_1',
        collateral_token: token_addr, question_hash: 0, category: 'test',
        outcome_count: 2, created_at: 0, resolution_time: 9999999,
        bond_refunded: false, voided: false, volume: 0, market_type: 0,
    };
    factory.set_market(market);

    let mut calldata: Array<felt252> = array![];
    OWNER().serialize(ref calldata);
    factory_addr.serialize(ref calldata);
    erc1155_addr.serialize(ref calldata);
    FEE_RECIPIENT().serialize(ref calldata);
    OPERATOR().serialize(ref calldata);
    let (exchange_addr, _) = exchange_class.deploy(@calldata).unwrap();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let valid_token_id = compute_token_id('cond_1', 0);

    // Fund and deposit for the bad maker.
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };
    mock.mint(bad_maker, 1000);
    cheat_caller_address(token_addr, bad_maker, CheatSpan::TargetCalls(1));
    erc20.approve(exchange_addr, 1000);
    cheat_caller_address(exchange_addr, bad_maker, CheatSpan::TargetCalls(1));
    exchange.deposit(token_addr, 1000);
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(bad_maker, token_addr, 100, 1, 9999999, 1);

    let maker: Order = Order {
        trader: bad_maker, market_id: 1, token_id: valid_token_id,
        is_buy: true, price: 1_000_000_000_000_000_000, amount: 100,
        nonce: 1, expiry: 9999999,
    };
    let taker: Order = Order {
        trader: good_taker, market_id: 1, token_id: valid_token_id,
        is_buy: false, price: 1_000_000_000_000_000_000, amount: 100,
        nonce: 2, expiry: 9999999,
    };

    // Should revert because maker's account rejects the signature.
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.settle_trade(maker, taker, 50, array![0, 0].span(), array![0, 0].span());
}

#[test]
#[should_panic(expected: 'CLOB: invalid signature')]
fn test_settle_trade_invalid_taker_signature_reverts() {
    let exchange_class = declare("CLOBExchange").unwrap().contract_class();
    let factory_addr = deploy_mock_market_factory();
    let erc1155_addr = deploy_mock_erc1155();
    let token_addr = deploy_mock_erc20();

    let good_maker = deploy_mock_account();
    let bad_taker = deploy_mock_bad_account();

    let factory = IMockMarketFactoryDispatcher { contract_address: factory_addr };
    let market: Market = Market {
        market_id: 1, creator: good_maker, condition_id: 'cond_1',
        collateral_token: token_addr, question_hash: 0, category: 'test',
        outcome_count: 2, created_at: 0, resolution_time: 9999999,
        bond_refunded: false, voided: false, volume: 0, market_type: 0,
    };
    factory.set_market(market);

    let mut calldata: Array<felt252> = array![];
    OWNER().serialize(ref calldata);
    factory_addr.serialize(ref calldata);
    erc1155_addr.serialize(ref calldata);
    FEE_RECIPIENT().serialize(ref calldata);
    OPERATOR().serialize(ref calldata);
    let (exchange_addr, _) = exchange_class.deploy(@calldata).unwrap();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let valid_token_id = compute_token_id('cond_1', 0);

    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };
    mock.mint(good_maker, 1000);
    cheat_caller_address(token_addr, good_maker, CheatSpan::TargetCalls(1));
    erc20.approve(exchange_addr, 1000);
    cheat_caller_address(exchange_addr, good_maker, CheatSpan::TargetCalls(1));
    exchange.deposit(token_addr, 1000);
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(good_maker, token_addr, 100, 1, 9999999, 1);

    let maker: Order = Order {
        trader: good_maker, market_id: 1, token_id: valid_token_id,
        is_buy: true, price: 1_000_000_000_000_000_000, amount: 100,
        nonce: 1, expiry: 9999999,
    };
    let taker: Order = Order {
        trader: bad_taker, market_id: 1, token_id: valid_token_id,
        is_buy: false, price: 1_000_000_000_000_000_000, amount: 100,
        nonce: 2, expiry: 9999999,
    };

    // Should revert because taker's account rejects the signature.
    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.settle_trade(maker, taker, 50, array![0, 0].span(), array![0, 0].span());
}

// -----------------------------------------------------------------
//  Tests: C-4 invalid token_id reverts
// -----------------------------------------------------------------

#[test]
#[should_panic(expected: 'CLOB: token_id not in condition')]
fn test_settle_trade_invalid_token_id_reverts() {
    let (exchange_addr, token_addr, _factory_addr, user_a, user_b) = deploy_exchange_with_mocks();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let invalid_token_id: u256 = 12345; // Not a valid Poseidon(cond_1, i)

    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    mock.mint(user_a, 1000);
    cheat_caller_address(token_addr, user_a, CheatSpan::TargetCalls(1));
    erc20.approve(exchange_addr, 1000);
    cheat_caller_address(exchange_addr, user_a, CheatSpan::TargetCalls(1));
    exchange.deposit(token_addr, 1000);

    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.reserve_balance(user_a, token_addr, 100, 1, 9999999, 1);

    let maker: Order = Order {
        trader: user_a, market_id: 1, token_id: invalid_token_id,
        is_buy: true, price: 1_000_000_000_000_000_000, amount: 100,
        nonce: 1, expiry: 9999999,
    };
    let taker: Order = Order {
        trader: user_b, market_id: 1, token_id: invalid_token_id,
        is_buy: false, price: 1_000_000_000_000_000_000, amount: 100,
        nonce: 2, expiry: 9999999,
    };

    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.settle_trade(maker, taker, 10, array![0, 0].span(), array![0, 0].span()); // Should panic
}

#[test]
#[should_panic(expected: 'CLOB: token_id not in condition')]
fn test_settle_dark_trade_invalid_token_id_reverts() {
    let (exchange_addr, _token_addr, _factory_addr, user_a, user_b) = deploy_dark_exchange_with_mocks();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let invalid_token_id: u256 = 12345;

    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.settle_dark_trade(
        1, invalid_token_id, 100, 1_000_000_000_000_000_000,
        user_a, user_b, true, 'bad_token',
    ); // Should panic
}

#[test]
#[should_panic(expected: 'CLOB: fill amount is zero')]
fn test_settle_dark_trade_zero_fill() {
    let (exchange_addr, _token_addr, _factory_addr, user_a, user_b) = deploy_dark_exchange_with_mocks();
    let exchange = ICLOBExchangeDispatcher { contract_address: exchange_addr };
    let valid_token_id = compute_token_id('cond_1', 0);

    cheat_caller_address(exchange_addr, OPERATOR(), CheatSpan::TargetCalls(1));
    exchange.settle_dark_trade(
        1, valid_token_id, 0, 1_000_000_000_000_000_000,
        user_a, user_b, true, 'zero',
    );
}
