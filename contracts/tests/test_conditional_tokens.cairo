/// Test scaffold for ConditionalTokens contract.
///
/// Uses Starknet Foundry's `snforge_std` for deployment helpers,
/// cheat codes, and assertions.

use snforge_std::{
    declare, ContractClassTrait, DeclareResultTrait,
    cheat_caller_address, CheatSpan,
};
use starknet::{ContractAddress, contract_address_const};

use market_zap::interfaces::i_conditional_tokens::{
    IConditionalTokensDispatcher, IConditionalTokensDispatcherTrait,
};

// -----------------------------------------------------------------
//  Test helpers
// -----------------------------------------------------------------

/// Fixed addresses used across tests.
fn OWNER() -> ContractAddress {
    contract_address_const::<'owner'>()
}

fn ORACLE() -> ContractAddress {
    contract_address_const::<'oracle'>()
}

fn USER_A() -> ContractAddress {
    contract_address_const::<'user_a'>()
}

fn USER_B() -> ContractAddress {
    contract_address_const::<'user_b'>()
}

/// Deploy the CollateralVault and ConditionalTokens contracts.
/// Returns (conditional_tokens_address, vault_address).
fn setup() -> (ContractAddress, ContractAddress) {
    // 1. Declare classes.
    let vault_class = declare("CollateralVault").unwrap().contract_class();
    let ct_class = declare("ConditionalTokens").unwrap().contract_class();

    // 2. Deploy vault first (needs CT address, but we can use a placeholder
    //    and set it later, or deploy CT first -- here we deploy with a
    //    temporary address and update via constructor workaround).
    //    For the scaffold, we deploy CT with a deterministic salt so we know
    //    the address ahead of time.

    // For testing, we use a two-step approach:
    //   - Deploy vault with a dummy CT address.
    //   - Deploy CT with the real vault address.
    //   - In production these would be deployed together or use a factory.

    // Dummy CT address for vault constructor.
    let dummy_ct: ContractAddress = contract_address_const::<0x1>();

    // Deploy vault.
    let mut vault_calldata: Array<felt252> = array![];
    OWNER().serialize(ref vault_calldata); // owner
    dummy_ct.serialize(ref vault_calldata); // conditional_tokens (placeholder)
    let (vault_addr, _) = vault_class.deploy(@vault_calldata).unwrap();

    // Deploy ConditionalTokens with the real vault address.
    let mut ct_calldata: Array<felt252> = array![];
    OWNER().serialize(ref ct_calldata); // owner
    vault_addr.serialize(ref ct_calldata); // vault
    // URI as ByteArray: empty for tests.
    let uri: ByteArray = "";
    uri.serialize(ref ct_calldata);
    let (ct_addr, _) = ct_class.deploy(@ct_calldata).unwrap();

    (ct_addr, vault_addr)
}

// -----------------------------------------------------------------
//  Tests
// -----------------------------------------------------------------

#[test]
fn test_prepare_condition_binary() {
    let (ct_addr, _vault_addr) = setup();
    let ct = IConditionalTokensDispatcher { contract_address: ct_addr };

    // Prepare a binary condition (2 outcomes).
    let question_id: felt252 = 'will_eth_hit_5k';
    let outcome_count: u32 = 2;

    cheat_caller_address(ct_addr, USER_A(), CheatSpan::TargetCalls(1));
    let condition_id = ct.prepare_condition(ORACLE(), question_id, outcome_count);

    // Verify the condition was stored.
    let view = ct.get_condition(condition_id);
    assert(view.oracle == ORACLE(), 'wrong oracle');
    assert(view.question_id == question_id, 'wrong question_id');
    assert(view.outcome_count == outcome_count, 'wrong outcome_count');
    assert(!view.resolved, 'should not be resolved');
    assert(view.payout_numerators.len() == 2, 'wrong numerators len');
}

#[test]
fn test_prepare_condition_multi_outcome() {
    let (ct_addr, _vault_addr) = setup();
    let ct = IConditionalTokensDispatcher { contract_address: ct_addr };

    let question_id: felt252 = 'who_wins_election';
    let outcome_count: u32 = 4;

    cheat_caller_address(ct_addr, USER_A(), CheatSpan::TargetCalls(1));
    let condition_id = ct.prepare_condition(ORACLE(), question_id, outcome_count);

    let view = ct.get_condition(condition_id);
    assert(view.outcome_count == 4, 'should have 4 outcomes');
    assert(view.payout_numerators.len() == 4, 'wrong numerators len');
}

#[test]
#[should_panic(expected: 'CT: outcome_count < 2')]
fn test_prepare_condition_invalid_outcome_count() {
    let (ct_addr, _vault_addr) = setup();
    let ct = IConditionalTokensDispatcher { contract_address: ct_addr };

    cheat_caller_address(ct_addr, USER_A(), CheatSpan::TargetCalls(1));
    ct.prepare_condition(ORACLE(), 'q', 1);
}

#[test]
fn test_get_position_token_id_deterministic() {
    let (ct_addr, _vault_addr) = setup();
    let ct = IConditionalTokensDispatcher { contract_address: ct_addr };

    cheat_caller_address(ct_addr, USER_A(), CheatSpan::TargetCalls(1));
    let condition_id = ct.prepare_condition(ORACLE(), 'q1', 2);

    let token_0 = ct.get_position_token_id(condition_id, 0);
    let token_1 = ct.get_position_token_id(condition_id, 1);

    // Token ids must be different.
    assert(token_0 != token_1, 'tokens should differ');

    // Calling again must be deterministic.
    let token_0_again = ct.get_position_token_id(condition_id, 0);
    assert(token_0 == token_0_again, 'should be deterministic');
}

#[test]
#[should_panic(expected: 'CT: condition already exists')]
fn test_prepare_condition_duplicate() {
    let (ct_addr, _vault_addr) = setup();
    let ct = IConditionalTokensDispatcher { contract_address: ct_addr };

    cheat_caller_address(ct_addr, USER_A(), CheatSpan::TargetCalls(2));
    ct.prepare_condition(ORACLE(), 'q1', 2);
    // Second call with same params from same caller should fail.
    ct.prepare_condition(ORACLE(), 'q1', 2);
}

#[test]
fn test_report_payouts() {
    let (ct_addr, _vault_addr) = setup();
    let ct = IConditionalTokensDispatcher { contract_address: ct_addr };

    cheat_caller_address(ct_addr, USER_A(), CheatSpan::TargetCalls(1));
    let condition_id = ct.prepare_condition(ORACLE(), 'q1', 2);

    // Report payouts as the oracle.
    let payouts: Array<u256> = array![1, 0];
    cheat_caller_address(ct_addr, ORACLE(), CheatSpan::TargetCalls(1));
    ct.report_payouts(condition_id, payouts.span());

    let view = ct.get_condition(condition_id);
    assert(view.resolved, 'should be resolved');
    assert(*view.payout_numerators.at(0) == 1, 'wrong numerator 0');
    assert(*view.payout_numerators.at(1) == 0, 'wrong numerator 1');
}

#[test]
#[should_panic(expected: 'CT: caller != oracle')]
fn test_report_payouts_not_oracle() {
    let (ct_addr, _vault_addr) = setup();
    let ct = IConditionalTokensDispatcher { contract_address: ct_addr };

    cheat_caller_address(ct_addr, USER_A(), CheatSpan::TargetCalls(1));
    let condition_id = ct.prepare_condition(ORACLE(), 'q1', 2);

    // Try to report as non-oracle.
    let payouts: Array<u256> = array![1, 0];
    cheat_caller_address(ct_addr, USER_B(), CheatSpan::TargetCalls(1));
    ct.report_payouts(condition_id, payouts.span());
}

#[test]
#[should_panic(expected: 'CT: payout len mismatch')]
fn test_report_payouts_wrong_length() {
    let (ct_addr, _vault_addr) = setup();
    let ct = IConditionalTokensDispatcher { contract_address: ct_addr };

    cheat_caller_address(ct_addr, USER_A(), CheatSpan::TargetCalls(1));
    let condition_id = ct.prepare_condition(ORACLE(), 'q1', 2);

    // Wrong number of payouts.
    let payouts: Array<u256> = array![1, 0, 0];
    cheat_caller_address(ct_addr, ORACLE(), CheatSpan::TargetCalls(1));
    ct.report_payouts(condition_id, payouts.span());
}
