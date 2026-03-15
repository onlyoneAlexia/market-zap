/// Tests for CollateralVault contract.

use snforge_std::{
    declare, ContractClassTrait, DeclareResultTrait,
    cheat_caller_address, CheatSpan,
};
use starknet::{ContractAddress, contract_address_const};

use market_zap::interfaces::i_collateral_vault::{
    ICollateralVaultDispatcher, ICollateralVaultDispatcherTrait,
};
use openzeppelin_interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use market_zap::mocks::mock_erc20::{IMockERC20Dispatcher, IMockERC20DispatcherTrait};

// -----------------------------------------------------------------
//  Helpers
// -----------------------------------------------------------------

fn OWNER() -> ContractAddress {
    contract_address_const::<'owner'>()
}

fn CT_CONTRACT() -> ContractAddress {
    contract_address_const::<'ct_contract'>()
}

fn USER() -> ContractAddress {
    contract_address_const::<'user'>()
}

fn RANDOM() -> ContractAddress {
    contract_address_const::<'random'>()
}

fn deploy_vault() -> ContractAddress {
    let vault_class = declare("CollateralVault").unwrap().contract_class();
    let mut calldata: Array<felt252> = array![];
    OWNER().serialize(ref calldata);
    CT_CONTRACT().serialize(ref calldata);
    let (addr, _) = vault_class.deploy(@calldata).unwrap();
    addr
}

fn deploy_mock_erc20() -> ContractAddress {
    let erc20_class = declare("MockERC20").unwrap().contract_class();
    let calldata: Array<felt252> = array![];
    let (addr, _) = erc20_class.deploy(@calldata).unwrap();
    addr
}

// -----------------------------------------------------------------
//  Tests: Token whitelist
// -----------------------------------------------------------------

#[test]
fn test_add_supported_token() {
    let vault_addr = deploy_vault();
    let vault = ICollateralVaultDispatcher { contract_address: vault_addr };
    let token = deploy_mock_erc20();

    assert(!vault.is_supported(token), 'should not be supported');

    cheat_caller_address(vault_addr, OWNER(), CheatSpan::TargetCalls(1));
    vault.add_supported_token(token);

    assert(vault.is_supported(token), 'should be supported');
}

#[test]
fn test_remove_supported_token() {
    let vault_addr = deploy_vault();
    let vault = ICollateralVaultDispatcher { contract_address: vault_addr };
    let token = deploy_mock_erc20();

    cheat_caller_address(vault_addr, OWNER(), CheatSpan::TargetCalls(2));
    vault.add_supported_token(token);
    vault.remove_supported_token(token);

    assert(!vault.is_supported(token), 'should not be supported');
}

#[test]
#[should_panic(expected: 'Caller is not the owner')]
fn test_add_supported_token_not_owner() {
    let vault_addr = deploy_vault();
    let vault = ICollateralVaultDispatcher { contract_address: vault_addr };
    let token = deploy_mock_erc20();

    cheat_caller_address(vault_addr, RANDOM(), CheatSpan::TargetCalls(1));
    vault.add_supported_token(token);
}

// -----------------------------------------------------------------
//  Tests: Deposit access control
// -----------------------------------------------------------------

#[test]
#[should_panic(expected: 'Vault: caller != CT')]
fn test_deposit_not_ct() {
    let vault_addr = deploy_vault();
    let vault = ICollateralVaultDispatcher { contract_address: vault_addr };
    let token = deploy_mock_erc20();

    // Try to deposit as a random user (not ConditionalTokens)
    cheat_caller_address(vault_addr, RANDOM(), CheatSpan::TargetCalls(1));
    vault.deposit(token, 'condition_1', USER(), 100);
}

#[test]
#[should_panic(expected: 'Vault: caller != CT')]
fn test_withdraw_not_ct() {
    let vault_addr = deploy_vault();
    let vault = ICollateralVaultDispatcher { contract_address: vault_addr };
    let token = deploy_mock_erc20();

    cheat_caller_address(vault_addr, RANDOM(), CheatSpan::TargetCalls(1));
    vault.withdraw(token, 'condition_1', USER(), 100);
}

#[test]
#[should_panic(expected: 'Vault: zero amount')]
fn test_deposit_zero_amount() {
    let vault_addr = deploy_vault();
    let vault = ICollateralVaultDispatcher { contract_address: vault_addr };
    let token = deploy_mock_erc20();

    // Whitelist token first so we hit the zero-amount check (not token-not-supported)
    cheat_caller_address(vault_addr, OWNER(), CheatSpan::TargetCalls(1));
    vault.add_supported_token(token);

    cheat_caller_address(vault_addr, CT_CONTRACT(), CheatSpan::TargetCalls(1));
    vault.deposit(token, 'condition_1', USER(), 0);
}

// -----------------------------------------------------------------
//  Tests: Balance tracking
// -----------------------------------------------------------------

#[test]
fn test_get_condition_balance_default_zero() {
    let vault_addr = deploy_vault();
    let vault = ICollateralVaultDispatcher { contract_address: vault_addr };
    let token = deploy_mock_erc20();

    let balance = vault.get_condition_balance(token, 'nonexistent');
    assert(balance == 0, 'should be zero');
}

// -----------------------------------------------------------------
//  Tests: Deposit with mock ERC20
// -----------------------------------------------------------------

#[test]
fn test_deposit_and_withdraw_flow() {
    let vault_addr = deploy_vault();
    let vault = ICollateralVaultDispatcher { contract_address: vault_addr };
    let token_addr = deploy_mock_erc20();
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    // Setup: add token to whitelist
    cheat_caller_address(vault_addr, OWNER(), CheatSpan::TargetCalls(1));
    vault.add_supported_token(token_addr);

    // Mint tokens to the user
    mock.mint(USER(), 1000);

    // User approves vault to spend
    cheat_caller_address(token_addr, USER(), CheatSpan::TargetCalls(1));
    erc20.approve(vault_addr, 500);

    // CT contract calls deposit on behalf of user
    cheat_caller_address(vault_addr, CT_CONTRACT(), CheatSpan::TargetCalls(1));
    vault.deposit(token_addr, 'cond_1', USER(), 500);

    // Check vault balance
    assert(vault.get_condition_balance(token_addr, 'cond_1') == 500, 'vault balance wrong');
    assert(erc20.balance_of(USER()) == 500, 'user balance wrong');
    assert(erc20.balance_of(vault_addr) == 500, 'vault token balance wrong');

    // CT contract calls withdraw
    cheat_caller_address(vault_addr, CT_CONTRACT(), CheatSpan::TargetCalls(1));
    vault.withdraw(token_addr, 'cond_1', USER(), 200);

    assert(vault.get_condition_balance(token_addr, 'cond_1') == 300, 'vault balance after');
    assert(erc20.balance_of(USER()) == 700, 'user balance after');
}

#[test]
#[should_panic(expected: 'Vault: insufficient balance')]
fn test_withdraw_insufficient_balance() {
    let vault_addr = deploy_vault();
    let vault = ICollateralVaultDispatcher { contract_address: vault_addr };
    let token_addr = deploy_mock_erc20();
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    cheat_caller_address(vault_addr, OWNER(), CheatSpan::TargetCalls(1));
    vault.add_supported_token(token_addr);

    mock.mint(USER(), 100);
    cheat_caller_address(token_addr, USER(), CheatSpan::TargetCalls(1));
    erc20.approve(vault_addr, 100);

    cheat_caller_address(vault_addr, CT_CONTRACT(), CheatSpan::TargetCalls(2));
    vault.deposit(token_addr, 'cond_1', USER(), 100);
    // Try to withdraw more than deposited
    vault.withdraw(token_addr, 'cond_1', USER(), 200);
}

// -----------------------------------------------------------------
//  Tests: M-7 remove_supported_token blocked with active balance
// -----------------------------------------------------------------

#[test]
#[should_panic(expected: 'Vault: token has active balance')]
fn test_remove_supported_token_with_active_balance() {
    let vault_addr = deploy_vault();
    let vault = ICollateralVaultDispatcher { contract_address: vault_addr };
    let token_addr = deploy_mock_erc20();
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    // Setup: whitelist + deposit
    cheat_caller_address(vault_addr, OWNER(), CheatSpan::TargetCalls(1));
    vault.add_supported_token(token_addr);

    mock.mint(USER(), 1000);
    cheat_caller_address(token_addr, USER(), CheatSpan::TargetCalls(1));
    erc20.approve(vault_addr, 500);

    cheat_caller_address(vault_addr, CT_CONTRACT(), CheatSpan::TargetCalls(1));
    vault.deposit(token_addr, 'cond_1', USER(), 500);

    // Try to remove token while balance exists — should panic
    cheat_caller_address(vault_addr, OWNER(), CheatSpan::TargetCalls(1));
    vault.remove_supported_token(token_addr);
}

#[test]
fn test_remove_supported_token_after_full_withdrawal() {
    let vault_addr = deploy_vault();
    let vault = ICollateralVaultDispatcher { contract_address: vault_addr };
    let token_addr = deploy_mock_erc20();
    let mock = IMockERC20Dispatcher { contract_address: token_addr };
    let erc20 = IERC20Dispatcher { contract_address: token_addr };

    // Setup: whitelist + deposit + full withdraw
    cheat_caller_address(vault_addr, OWNER(), CheatSpan::TargetCalls(1));
    vault.add_supported_token(token_addr);

    mock.mint(USER(), 1000);
    cheat_caller_address(token_addr, USER(), CheatSpan::TargetCalls(1));
    erc20.approve(vault_addr, 500);

    cheat_caller_address(vault_addr, CT_CONTRACT(), CheatSpan::TargetCalls(2));
    vault.deposit(token_addr, 'cond_1', USER(), 500);
    vault.withdraw(token_addr, 'cond_1', USER(), 500);

    // Now removal should succeed
    cheat_caller_address(vault_addr, OWNER(), CheatSpan::TargetCalls(1));
    vault.remove_supported_token(token_addr);
    assert(!vault.is_supported(token_addr), 'should be removed');
}

#[test]
#[should_panic(expected: 'Vault: token not supported')]
fn test_deposit_unsupported_token() {
    let vault_addr = deploy_vault();
    let vault = ICollateralVaultDispatcher { contract_address: vault_addr };
    let token_addr = deploy_mock_erc20();

    // Don't add token to whitelist
    cheat_caller_address(vault_addr, CT_CONTRACT(), CheatSpan::TargetCalls(1));
    vault.deposit(token_addr, 'cond_1', USER(), 100);
}
