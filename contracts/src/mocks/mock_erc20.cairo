/// MockERC20 — test USDC token using OpenZeppelin ERC20 component.
/// Uses OZ components so all Transfer/Approval events are emitted automatically,
/// which is required for Voyager/block explorers to display token transfers.
/// Includes a public `mint` entrypoint for testnet faucet use.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockERC20<TContractState> {
    fn mint(ref self: TContractState, to: ContractAddress, amount: u256);
}

#[starknet::contract]
pub mod MockERC20 {
    use starknet::ContractAddress;
    use openzeppelin_token::erc20::{ERC20Component, ERC20HooksEmptyImpl};

    /// USDC uses 6 decimals, not the OZ default of 18.
    pub impl UsdcConfig of ERC20Component::ImmutableConfig {
        const DECIMALS: u8 = 6;
    }

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    // Embed the full ERC20 mixin (balance_of, transfer, transfer_from, approve, allowance, etc.)
    // All transfer/approval operations automatically emit Transfer/Approval events.
    #[abi(embed_v0)]
    impl ERC20MixinImpl = ERC20Component::ERC20MixinImpl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {
        self.erc20.initializer("MarketZap Test USDC", "USDC");
    }

    #[abi(embed_v0)]
    impl MockERC20Impl of super::IMockERC20<ContractState> {
        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            self.erc20.mint(to, amount);
        }
    }
}
