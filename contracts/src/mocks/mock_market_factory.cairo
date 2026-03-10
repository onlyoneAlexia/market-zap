/// Mock MarketFactory for unit tests.
///
/// Exposes `get_market` with the same selector/signature as the real
/// MarketFactory interface, so other contracts (e.g., CLOBExchange) can
/// call it via `IMarketFactoryDispatcher`.

use market_zap::interfaces::i_market_factory::Market;

#[starknet::interface]
pub trait IMockMarketFactory<TContractState> {
    fn set_market(ref self: TContractState, market: Market);
    fn get_market(self: @TContractState, market_id: u64) -> Market;
    fn increment_volume(ref self: TContractState, market_id: u64, amount: u256);
}

#[starknet::contract]
pub mod MockMarketFactory {
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use market_zap::interfaces::i_market_factory::Market;

    #[storage]
    struct Storage {
        markets: Map<u64, Market>,
    }

    // -----------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------
    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        MarketSet: MarketSet,
    }

    #[derive(Drop, starknet::Event)]
    pub struct MarketSet {
        #[key]
        pub market_id: u64,
    }

    // -----------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------
    pub mod Errors {
        pub const MARKET_NOT_FOUND: felt252 = 'MockMF: market not found';
    }

    // -----------------------------------------------------------------
    //  Implementation
    // -----------------------------------------------------------------
    #[abi(embed_v0)]
    impl MockMarketFactoryImpl of super::IMockMarketFactory<ContractState> {
        fn set_market(ref self: ContractState, market: Market) {
            self.markets.write(market.market_id, market);
            self.emit(MarketSet { market_id: market.market_id });
        }

        fn get_market(self: @ContractState, market_id: u64) -> Market {
            let market = self.markets.read(market_id);
            // A default/empty market has market_id=0.
            assert(market.market_id != 0, Errors::MARKET_NOT_FOUND);
            market
        }

        fn increment_volume(ref self: ContractState, market_id: u64, amount: u256) {
            let mut market = self.markets.read(market_id);
            market.volume = market.volume + amount;
            self.markets.write(market_id, market);
        }
    }
}
