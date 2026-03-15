// =====================================================================
//  Market-Zap: Prediction Market Smart Contracts
// =====================================================================

// -----------------------------------------------------------------
//  Interfaces
// -----------------------------------------------------------------
pub mod interfaces {
    pub mod i_conditional_tokens;
    pub mod i_collateral_vault;
    pub mod i_market_factory;
    pub mod i_clob_exchange;
    pub mod i_admin_resolver;
}

// -----------------------------------------------------------------
//  Contracts
// -----------------------------------------------------------------
pub mod conditional_tokens;
pub mod collateral_vault;
pub mod market_factory;
pub mod clob_exchange;
pub mod admin_resolver;

// -----------------------------------------------------------------
//  Test mocks (only included in test builds)
// -----------------------------------------------------------------
pub mod mocks {
    pub mod mock_erc20;
    pub mod mock_market_factory;
    pub mod mock_erc1155;
    pub mod mock_account;
    pub mod mock_bad_account;
}
