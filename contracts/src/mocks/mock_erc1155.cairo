/// Minimal ERC-1155 mock for unit tests.
///
/// Implements `safe_transfer_from` so CLOBExchange settlement can be tested
/// without deploying the full ConditionalTokens stack.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockERC1155<TContractState> {
    fn safe_transfer_from(
        ref self: TContractState,
        from: ContractAddress,
        to: ContractAddress,
        id: u256,
        amount: u256,
        data: Span<felt252>,
    );
}

#[starknet::contract]
pub mod MockERC1155 {
    use starknet::ContractAddress;

    #[storage]
    struct Storage {}

    // -----------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------
    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        Transfer: Transfer,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Transfer {
        #[key]
        pub from: ContractAddress,
        #[key]
        pub to: ContractAddress,
        pub id: u256,
        pub amount: u256,
    }

    // -----------------------------------------------------------------
    //  Implementation
    // -----------------------------------------------------------------
    #[abi(embed_v0)]
    impl MockERC1155Impl of super::IMockERC1155<ContractState> {
        fn safe_transfer_from(
            ref self: ContractState,
            from: ContractAddress,
            to: ContractAddress,
            id: u256,
            amount: u256,
            data: Span<felt252>,
        ) {
            self.emit(Transfer { from, to, id, amount });
        }
    }
}
