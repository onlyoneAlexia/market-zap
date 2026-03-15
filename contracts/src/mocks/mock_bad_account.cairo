/// Mock Account that always REJECTS signatures.
///
/// Used in C-1 negative tests to verify that invalid signatures cause reverts.

#[starknet::interface]
pub trait IMockBadAccount<TContractState> {
    fn is_valid_signature(
        self: @TContractState,
        hash: felt252,
        signature: Array<felt252>,
    ) -> felt252;
}

#[starknet::contract]
pub mod MockBadAccount {
    #[storage]
    struct Storage {}

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {}

    #[abi(embed_v0)]
    impl MockBadAccountImpl of super::IMockBadAccount<ContractState> {
        fn is_valid_signature(
            self: @ContractState,
            hash: felt252,
            signature: Array<felt252>,
        ) -> felt252 {
            0 // Always invalid
        }
    }
}
