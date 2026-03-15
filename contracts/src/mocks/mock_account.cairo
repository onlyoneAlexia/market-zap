/// Mock Account for unit tests.
///
/// Always returns VALIDATED for is_valid_signature, allowing
/// settle_trade tests to pass without real ECDSA signatures.

#[starknet::interface]
pub trait IMockAccount<TContractState> {
    fn is_valid_signature(
        self: @TContractState,
        hash: felt252,
        signature: Array<felt252>,
    ) -> felt252;
}

#[starknet::contract]
pub mod MockAccount {
    #[storage]
    struct Storage {}

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {}

    #[abi(embed_v0)]
    impl MockAccountImpl of super::IMockAccount<ContractState> {
        fn is_valid_signature(
            self: @ContractState,
            hash: felt252,
            signature: Array<felt252>,
        ) -> felt252 {
            starknet::VALIDATED
        }
    }
}
