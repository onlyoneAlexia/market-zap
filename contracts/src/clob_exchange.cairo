/// CLOBExchange -- Central-limit order book settlement for Market-Zap.
///
/// Users deposit/withdraw collateral.  An off-chain matching engine pairs
/// maker and taker orders; settlement happens on-chain one trade at a time.
///
/// Balance reservation prevents double-spending while orders are open.
/// After expiry, anyone can release a reservation back to the user.
///
/// P0 fixes (v6):
///   - Configurable fees (set_fees, stored in storage)
///   - Emergency withdrawal when paused
///   - Per-nonce reservation expiry tracking
///   - On-chain volume increment via MarketFactory
///   - Trading halt enforcement (resolution_time check)
///   - Operator/fee_recipient rotation (set_operator, set_fee_recipient)

#[starknet::contract]
pub mod CLOBExchange {
    // -----------------------------------------------------------------
    //  Imports
    // -----------------------------------------------------------------
    use core::hash::HashStateTrait;
    use core::num::traits::Zero;
    use core::poseidon::PoseidonTrait;
    use starknet::{
        ContractAddress, get_caller_address, get_contract_address, get_block_timestamp,
        get_tx_info,
        storage::{Map, StorageMapReadAccess, StorageMapWriteAccess},
    };
    use starknet::storage::StoragePointerReadAccess;
    use starknet::storage::StoragePointerWriteAccess;

    use openzeppelin_access::ownable::OwnableComponent;
    use openzeppelin_security::reentrancyguard::ReentrancyGuardComponent;
    use openzeppelin_security::pausable::PausableComponent;
    use openzeppelin_upgrades::UpgradeableComponent;
    use openzeppelin_interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::class_hash::ClassHash;

    use market_zap::interfaces::i_clob_exchange::Order;
    use market_zap::interfaces::i_market_factory::{
        IMarketFactoryDispatcher, IMarketFactoryDispatcherTrait,
    };
    use openzeppelin_interfaces::erc1155::{IERC1155Dispatcher, IERC1155DispatcherTrait};
    use openzeppelin_interfaces::accounts::{ISRC6Dispatcher, ISRC6DispatcherTrait};

    // -----------------------------------------------------------------
    //  Components
    // -----------------------------------------------------------------
    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(
        path: ReentrancyGuardComponent, storage: reentrancy_guard, event: ReentrancyGuardEvent,
    );
    component!(path: PausableComponent, storage: pausable, event: PausableEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);

    #[abi(embed_v0)]
    impl OwnableMixinImpl = OwnableComponent::OwnableMixinImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;
    impl ReentrancyGuardInternalImpl = ReentrancyGuardComponent::InternalImpl<ContractState>;
    #[abi(embed_v0)]
    impl PausableImpl = PausableComponent::PausableImpl<ContractState>;
    impl PausableInternalImpl = PausableComponent::InternalImpl<ContractState>;
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    // -----------------------------------------------------------------
    //  Constants
    // -----------------------------------------------------------------
    const BPS_DENOMINATOR: u256 = 10_000;
    /// Max fee cap: 5% = 500 basis points.
    const MAX_FEE_BPS: u256 = 500;
    /// Contract version for upgrade tracking — v6: configurable fees + P0 fixes.
    const CONTRACT_VERSION: felt252 = 6;
    /// 48-hour upgrade timelock.
    const UPGRADE_TIMELOCK_SECONDS: u64 = 48 * 60 * 60;

    // -----------------------------------------------------------------
    //  SNIP-12 Constants (Revision 1 — Poseidon-based)
    // -----------------------------------------------------------------
    const SNIP12_MESSAGE_PREFIX: felt252 = 0x537461726b4e6574204d657373616765;
    const DOMAIN_TYPE_HASH: felt252 =
        0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210;
    const ORDER_TYPE_HASH: felt252 =
        0x3963de030c5386deafeff7fd1dfd4d11bdaa8b103857c7968d0405b6e1d655b;
    const U256_TYPE_HASH: felt252 =
        0x3b143be38b811560b45593fb2a071ec4ddd0a020e10782be62ffe6f39e0e82c;
    const DOMAIN_NAME: felt252 = 'MarketZap';
    // Use integer 1, not shortstring '1' (0x31). starknet.js encodes
    // domain { version: "1" } as felt 0x1 via toHex("1"), so Cairo must match.
    const DOMAIN_VERSION: felt252 = 1;

    // -----------------------------------------------------------------
    //  Storage
    // -----------------------------------------------------------------
    #[storage]
    struct Storage {
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        reentrancy_guard: ReentrancyGuardComponent::Storage,
        #[substorage(v0)]
        pausable: PausableComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        /// MarketFactory contract (for volume reporting + trading halt).
        market_factory: ContractAddress,
        /// ConditionalTokens contract (for split/merge).
        conditional_tokens: ContractAddress,
        /// Fee recipient address.
        fee_recipient: ContractAddress,
        /// Operator address authorized to call settle_trade.
        operator: ContractAddress,
        /// Configurable taker fee in basis points.
        taker_fee_bps: u256,
        /// Configurable maker fee in basis points.
        maker_fee_bps: u256,
        /// (user, token) -> available balance.
        balances: Map<(ContractAddress, ContractAddress), u256>,
        /// (user, token) -> reserved (locked for open orders).
        reserved: Map<(ContractAddress, ContractAddress), u256>,
        /// (user, nonce) -> bool: whether a nonce has been consumed.
        nonces_used: Map<(ContractAddress, u256), bool>,
        /// (user, nonce) -> total order amount (locked on first fill).
        nonce_total: Map<(ContractAddress, u256), u256>,
        /// (user, nonce) -> cumulative filled amount.
        nonce_filled: Map<(ContractAddress, u256), u256>,
        /// (user, nonce) -> immutable SNIP-12 order hash (locked on first fill).
        nonce_hash: Map<(ContractAddress, u256), felt252>,
        /// (user, nonce) -> reservation amount for this specific order.
        reservation_amounts: Map<(ContractAddress, u256), u256>,
        /// (user, nonce) -> expiry timestamp for per-nonce reservation tracking.
        reservation_expiries: Map<(ContractAddress, u256), u128>,
        /// (user, nonce) -> token address reserved under this nonce.
        reservation_tokens: Map<(ContractAddress, u256), ContractAddress>,
        /// (user, nonce) -> market_id this reservation is for.
        reservation_market_ids: Map<(ContractAddress, u256), u64>,
        /// Dark trade nonce tracking: commitment -> bool (used).
        dark_nonces_used: Map<felt252, bool>,
        /// Upgrade timelock fields.
        proposed_upgrade: ClassHash,
        upgrade_proposed_at: u64,
        /// Dark market registry: market_id -> is_dark.
        dark_markets: Map<u128, bool>,
    }

    // -----------------------------------------------------------------
    //  Events
    // -----------------------------------------------------------------
    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        ReentrancyGuardEvent: ReentrancyGuardComponent::Event,
        #[flat]
        PausableEvent: PausableComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
        Deposit: Deposit,
        Withdrawal: Withdrawal,
        BalanceReserved: BalanceReserved,
        BalanceReleased: BalanceReleased,
        TradeSettled: TradeSettled,
        DarkTradeSettled: DarkTradeSettled,
        DarkMarketRegistered: DarkMarketRegistered,
        OrderCancelled: OrderCancelled,
        ContractUpgraded: ContractUpgraded,
        OperatorUpdated: OperatorUpdated,
        FeeRecipientUpdated: FeeRecipientUpdated,
        FeesUpdated: FeesUpdated,
        UpgradeProposed: UpgradeProposed,
        UpgradeCancelled: UpgradeCancelled,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ContractUpgraded {
        pub new_version: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Deposit {
        #[key]
        pub user: ContractAddress,
        pub token: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Withdrawal {
        #[key]
        pub user: ContractAddress,
        pub token: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct BalanceReserved {
        #[key]
        pub user: ContractAddress,
        pub token: ContractAddress,
        pub amount: u256,
        pub expiry: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct BalanceReleased {
        #[key]
        pub user: ContractAddress,
        pub token: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct TradeSettled {
        #[key]
        pub maker: ContractAddress,
        #[key]
        pub taker: ContractAddress,
        pub market_id: u128,
        pub token_id: u256,
        pub fill_amount: u256,
        pub price: u256,
        pub taker_fee: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OrderCancelled {
        #[key]
        pub user: ContractAddress,
        pub nonce: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OperatorUpdated {
        pub old_operator: ContractAddress,
        pub new_operator: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct FeeRecipientUpdated {
        pub old_recipient: ContractAddress,
        pub new_recipient: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct FeesUpdated {
        pub maker_fee_bps: u256,
        pub taker_fee_bps: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct DarkTradeSettled {
        #[key]
        pub market_id: u128,
        pub trade_commitment: felt252,
        pub fill_amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct DarkMarketRegistered {
        #[key]
        pub market_id: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct UpgradeProposed {
        pub new_class_hash: ClassHash,
        pub proposed_at: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct UpgradeCancelled {}

    // -----------------------------------------------------------------
    //  Errors
    // -----------------------------------------------------------------
    pub mod Errors {
        pub const ZERO_AMOUNT: felt252 = 'CLOB: zero amount';
        pub const INSUFFICIENT_BALANCE: felt252 = 'CLOB: insufficient balance';
        pub const INSUFFICIENT_RESERVED: felt252 = 'CLOB: insufficient reserved';
        pub const NONCE_ALREADY_USED: felt252 = 'CLOB: nonce already used';
        pub const ORDER_PARAMS_MISMATCH: felt252 = 'CLOB: order params mismatch';
        pub const ORDER_EXPIRED: felt252 = 'CLOB: order expired';
        pub const RESERVATION_NOT_EXPIRED: felt252 = 'CLOB: reservation not expired';
        pub const INVALID_SIGNATURE: felt252 = 'CLOB: invalid signature';
        pub const MARKET_MISMATCH: felt252 = 'CLOB: market id mismatch';
        pub const TOKEN_MISMATCH: felt252 = 'CLOB: token id mismatch';
        pub const SIDE_MISMATCH: felt252 = 'CLOB: same side orders';
        pub const PRICE_MISMATCH: felt252 = 'CLOB: price cross invalid';
        pub const CALLER_NOT_OPERATOR: felt252 = 'CLOB: caller != operator';
        pub const FILL_EXCEEDS_ORDER: felt252 = 'CLOB: fill > order amount';
        pub const FILL_ZERO: felt252 = 'CLOB: fill amount is zero';
        pub const ZERO_COST: felt252 = 'CLOB: zero cost trade';
        pub const SELF_TRADE: felt252 = 'CLOB: self-trade not allowed';
        pub const UPGRADE_NOT_PROPOSED: felt252 = 'CLOB: no pending upgrade';
        pub const UPGRADE_TIMELOCK: felt252 = 'CLOB: timelock not elapsed';
        pub const UPGRADE_ALREADY_PENDING: felt252 = 'CLOB: upgrade already pending';
        pub const ZERO_ADDRESS: felt252 = 'CLOB: zero address';
        pub const FEE_TOO_HIGH: felt252 = 'CLOB: fee exceeds max';
        pub const MARKET_CLOSED: felt252 = 'CLOB: market closed';
        pub const MARKET_RESOLVED: felt252 = 'CLOB: market resolved';
        pub const MARKET_VOIDED: felt252 = 'CLOB: market is voided';
        pub const NOT_DARK_MARKET: felt252 = 'CLOB: not a dark market';
        pub const ALREADY_DARK: felt252 = 'CLOB: already dark market';
        pub const NONCE_ALREADY_RESERVED: felt252 = 'CLOB: nonce already reserved';
        pub const NONCE_NO_RESERVATION: felt252 = 'CLOB: no reservation for nonce';
        pub const RELEASE_EXCEEDS_NONCE: felt252 = 'CLOB: release > nonce amount';
        pub const DARK_NONCE_USED: felt252 = 'CLOB: dark nonce already used';
        pub const INVALID_TOKEN_ID: felt252 = 'CLOB: token_id not in condition';
    }

    // -----------------------------------------------------------------
    //  Constructor
    // -----------------------------------------------------------------
    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        market_factory: ContractAddress,
        conditional_tokens: ContractAddress,
        fee_recipient: ContractAddress,
        operator: ContractAddress,
    ) {
        assert(!market_factory.is_zero(), 'CLOB: zero market_factory');
        assert(!conditional_tokens.is_zero(), 'CLOB: zero cond_tokens');
        assert(!fee_recipient.is_zero(), 'CLOB: zero fee_recipient');
        assert(!operator.is_zero(), 'CLOB: zero operator');
        self.ownable.initializer(owner);
        self.market_factory.write(market_factory);
        self.conditional_tokens.write(conditional_tokens);
        self.fee_recipient.write(fee_recipient);
        self.operator.write(operator);
        // Default fees: 0% maker, 1% taker.
        self.maker_fee_bps.write(0);
        self.taker_fee_bps.write(100);
    }

    // -----------------------------------------------------------------
    //  Upgrade with 48-hour timelock
    // -----------------------------------------------------------------
    #[abi(embed_v0)]
    impl UpgradeTimelockImpl of super::ICLOBUpgradeTimelock<ContractState> {
        fn propose_upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            self.ownable.assert_only_owner();
            let existing = self.proposed_upgrade.read();
            assert(existing.is_zero(), Errors::UPGRADE_ALREADY_PENDING);
            let now = get_block_timestamp();
            self.proposed_upgrade.write(new_class_hash);
            self.upgrade_proposed_at.write(now);
            // L-5 fix: emit event.
            self.emit(UpgradeProposed { new_class_hash, proposed_at: now });
        }

        fn execute_upgrade(ref self: ContractState) {
            self.ownable.assert_only_owner();
            let proposed = self.proposed_upgrade.read();
            assert(proposed.is_non_zero(), Errors::UPGRADE_NOT_PROPOSED);
            let proposed_at = self.upgrade_proposed_at.read();
            let now = get_block_timestamp();
            assert(now >= proposed_at + UPGRADE_TIMELOCK_SECONDS, Errors::UPGRADE_TIMELOCK);
            self.proposed_upgrade.write(Zero::zero());
            self.upgrade_proposed_at.write(0);
            self.upgradeable.upgrade(proposed);
        }

        fn cancel_upgrade(ref self: ContractState) {
            self.ownable.assert_only_owner();
            let proposed = self.proposed_upgrade.read();
            assert(proposed.is_non_zero(), Errors::UPGRADE_NOT_PROPOSED);
            self.proposed_upgrade.write(Zero::zero());
            self.upgrade_proposed_at.write(0);
            // L-5 fix: emit event.
            self.emit(UpgradeCancelled {});
        }
    }

    // -----------------------------------------------------------------
    //  Pause (owner-only)
    // -----------------------------------------------------------------
    #[abi(embed_v0)]
    impl PauseImpl of super::ICLOBPause<ContractState> {
        fn pause(ref self: ContractState) {
            self.ownable.assert_only_owner();
            self.pausable.pause();
        }

        fn unpause(ref self: ContractState) {
            self.ownable.assert_only_owner();
            self.pausable.unpause();
        }
    }

    // -----------------------------------------------------------------
    //  ICLOBExchange implementation
    // -----------------------------------------------------------------
    #[abi(embed_v0)]
    impl CLOBExchangeImpl of market_zap::interfaces::i_clob_exchange::ICLOBExchange<
        ContractState,
    > {
        fn deposit(ref self: ContractState, token: ContractAddress, amount: u256) {
            self.pausable.assert_not_paused();
            self.reentrancy_guard.start();
            assert(amount > 0, Errors::ZERO_AMOUNT);

            let caller = get_caller_address();
            let this = get_contract_address();

            let erc20 = IERC20Dispatcher { contract_address: token };
            let balance_before = erc20.balance_of(this);
            // M-6 fix: assert ERC20 transfer_from succeeds.
            assert(erc20.transfer_from(caller, this, amount), 'CLOB: transfer_from failed');
            let balance_after = erc20.balance_of(this);
            let actual_received = balance_after - balance_before;

            let current = self.balances.read((caller, token));
            self.balances.write((caller, token), current + actual_received);

            self.emit(Deposit { user: caller, token, amount: actual_received });
            self.reentrancy_guard.end();
        }

        fn withdraw(ref self: ContractState, token: ContractAddress, amount: u256) {
            self.reentrancy_guard.start();
            assert(amount > 0, Errors::ZERO_AMOUNT);

            let caller = get_caller_address();

            let current = self.balances.read((caller, token));
            assert(current >= amount, Errors::INSUFFICIENT_BALANCE);
            self.balances.write((caller, token), current - amount);

            let erc20 = IERC20Dispatcher { contract_address: token };
            // M-6 fix: assert ERC20 transfer succeeds.
            assert(erc20.transfer(caller, amount), 'CLOB: transfer failed');

            self.emit(Withdrawal { user: caller, token, amount });
            self.reentrancy_guard.end();
        }

        /// C2: Emergency withdraw all available balance when contract is paused.
        /// Allows users to exit even during a crisis. Only withdraws available
        /// (non-reserved) balance — reserved funds need explicit release first.
        fn emergency_withdraw(ref self: ContractState, token: ContractAddress) {
            self.pausable.assert_paused();
            self.reentrancy_guard.start();

            let caller = get_caller_address();
            let amount = self.balances.read((caller, token));
            assert(amount > 0, Errors::ZERO_AMOUNT);

            self.balances.write((caller, token), 0);

            let erc20 = IERC20Dispatcher { contract_address: token };
            // M-6 fix: assert ERC20 transfer succeeds.
            assert(erc20.transfer(caller, amount), 'CLOB: transfer failed');

            self.emit(Withdrawal { user: caller, token, amount });
            self.reentrancy_guard.end();
        }

        /// C5c: Per-nonce reservation tracking. Each reservation is keyed by
        /// (user, nonce) to prevent concurrent orders from overwriting expiries.
        /// H-2 fix: operator-only to prevent user manipulation of nonce metadata.
        fn reserve_balance(
            ref self: ContractState,
            user: ContractAddress,
            token: ContractAddress,
            amount: u256,
            nonce: u256,
            expiry: u128,
            market_id: u64,
        ) {
            self.pausable.assert_not_paused();
            let caller = get_caller_address();
            assert(caller == self.operator.read(), Errors::CALLER_NOT_OPERATOR);
            assert(amount > 0, Errors::ZERO_AMOUNT);

            // Assert nonce is not already reserved (prevents silent overwrite).
            let existing_reservation = self.reservation_amounts.read((user, nonce));
            assert(existing_reservation == 0, Errors::NONCE_ALREADY_RESERVED);

            let available = self.balances.read((user, token));
            assert(available >= amount, Errors::INSUFFICIENT_BALANCE);

            // Move from available to reserved.
            self.balances.write((user, token), available - amount);
            let current_reserved = self.reserved.read((user, token));
            self.reserved.write((user, token), current_reserved + amount);

            // Per-nonce reservation tracking (C5c fix).
            // H-3 fix: store token per nonce for cross-token validation.
            self.reservation_amounts.write((user, nonce), amount);
            self.reservation_expiries.write((user, nonce), expiry);
            self.reservation_tokens.write((user, nonce), token);
            self.reservation_market_ids.write((user, nonce), market_id);

            self.emit(BalanceReserved { user, token, amount, expiry });
        }

        /// C5c: Release uses per-nonce expiry for permissionless release.
        /// H-3 fix: validate nonce has a reservation, token matches, cap amount.
        fn release_balance(
            ref self: ContractState,
            user: ContractAddress,
            token: ContractAddress,
            nonce: u256,
            amount: u256,
        ) {
            assert(amount > 0, Errors::ZERO_AMOUNT);

            // H-3 fix: nonce must have an active reservation.
            let nonce_reserved = self.reservation_amounts.read((user, nonce));
            assert(nonce_reserved > 0, Errors::NONCE_NO_RESERVATION);

            // H-3 fix: token must match what was reserved under this nonce.
            let reserved_token = self.reservation_tokens.read((user, nonce));
            assert(reserved_token == token, Errors::TOKEN_MISMATCH);

            // H-3 fix: cannot release more than was reserved under this nonce.
            assert(amount <= nonce_reserved, Errors::RELEASE_EXCEEDS_NONCE);

            let caller = get_caller_address();
            let is_authorized = caller == self.operator.read() || caller == user;
            // Third parties can only release after per-nonce expiry.
            if !is_authorized {
                let now: u128 = get_block_timestamp().into();
                let expiry = self.reservation_expiries.read((user, nonce));
                assert(now >= expiry, Errors::RESERVATION_NOT_EXPIRED);
            }

            let current_reserved = self.reserved.read((user, token));
            assert(current_reserved >= amount, Errors::INSUFFICIENT_RESERVED);

            self.reserved.write((user, token), current_reserved - amount);
            let available = self.balances.read((user, token));
            self.balances.write((user, token), available + amount);

            // Update per-nonce reservation tracking.
            self.reservation_amounts.write((user, nonce), nonce_reserved - amount);
            if nonce_reserved == amount {
                // Fully released — clear expiry and token tracking.
                self.reservation_expiries.write((user, nonce), 0);
            }

            self.emit(BalanceReleased { user, token, amount });
        }

        fn settle_trade(
            ref self: ContractState,
            maker_order: Order,
            taker_order: Order,
            fill_amount: u256,
            maker_signature: Span<felt252>,
            taker_signature: Span<felt252>,
        ) {
            self.pausable.assert_not_paused();
            self.reentrancy_guard.start();

            // Only operator can settle.
            let caller = get_caller_address();
            assert(caller == self.operator.read(), Errors::CALLER_NOT_OPERATOR);

            let now: u128 = get_block_timestamp().into();

            // ---- Validations ----
            assert(fill_amount > 0, Errors::FILL_ZERO);
            assert(fill_amount <= maker_order.amount, Errors::FILL_EXCEEDS_ORDER);
            assert(fill_amount <= taker_order.amount, Errors::FILL_EXCEEDS_ORDER);

            assert(maker_order.market_id == taker_order.market_id, Errors::MARKET_MISMATCH);
            assert(maker_order.token_id == taker_order.token_id, Errors::TOKEN_MISMATCH);
            assert(maker_order.is_buy != taker_order.is_buy, Errors::SIDE_MISMATCH);

            if maker_order.is_buy {
                assert(maker_order.price >= taker_order.price, Errors::PRICE_MISMATCH);
            } else {
                assert(taker_order.price >= maker_order.price, Errors::PRICE_MISMATCH);
            }

            assert(maker_order.expiry > now, Errors::ORDER_EXPIRED);
            assert(taker_order.expiry > now, Errors::ORDER_EXPIRED);

            // C5e: Trading halt — check market is still active (not past resolution_time, not voided).
            let mf = IMarketFactoryDispatcher {
                contract_address: self.market_factory.read(),
            };
            let market = mf.get_market(maker_order.market_id.try_into().unwrap());
            assert(!market.voided, Errors::MARKET_VOIDED);
            let now_u64 = get_block_timestamp();
            assert(now_u64 < market.resolution_time, Errors::MARKET_CLOSED);

            // C-4 fix: validate token_id belongs to this market's condition.
            validate_token_id(market.condition_id, market.outcome_count, maker_order.token_id);

            // Nonces.
            assert(
                !self.nonces_used.read((maker_order.trader, maker_order.nonce)),
                Errors::NONCE_ALREADY_USED,
            );
            assert(
                !self.nonces_used.read((taker_order.trader, taker_order.nonce)),
                Errors::NONCE_ALREADY_USED,
            );

            // H-4 fix: reject self-trades to prevent wash trading.
            assert(maker_order.trader != taker_order.trader, Errors::SELF_TRADE);

            // C-1 fix: ALWAYS verify signatures — no bypass for (0,0).
            let maker_hash = hash_order(@maker_order);
            let taker_hash = hash_order(@taker_order);

            verify_signature(maker_order.trader, maker_hash, maker_signature);
            verify_signature(taker_order.trader, taker_hash, taker_signature);

            // ---- Partial-fill nonce accounting ----
            apply_fill(
                ref self,
                maker_order.trader,
                maker_order.nonce,
                maker_order.amount,
                maker_hash,
                fill_amount,
            );
            apply_fill(
                ref self,
                taker_order.trader,
                taker_order.nonce,
                taker_order.amount,
                taker_hash,
                fill_amount,
            );

            // ---- Calculate fees (C3: configurable) ----
            let execution_price = maker_order.price;
            let cost = (fill_amount * execution_price) / 1_000_000_000_000_000_000;
            // C-5 fix: prevent zero-cost trades from truncation.
            assert(cost > 0, Errors::ZERO_COST);
            let current_taker_fee_bps = self.taker_fee_bps.read();
            let taker_fee = (cost * current_taker_fee_bps) / BPS_DENOMINATOR;

            // ---- Settlement: collateral + ERC-1155 outcome token transfer ----
            let collateral = market.collateral_token;

            let erc1155 = IERC1155Dispatcher {
                contract_address: self.conditional_tokens.read(),
            };

            let (buyer, seller) = if maker_order.is_buy {
                (maker_order.trader, taker_order.trader)
            } else {
                (taker_order.trader, maker_order.trader)
            };

            if maker_order.is_buy {
                let maker_res = self.reserved.read((maker_order.trader, collateral));
                assert(maker_res >= cost, Errors::INSUFFICIENT_RESERVED);
                self.reserved.write((maker_order.trader, collateral), maker_res - cost);

                let taker_bal = self.balances.read((taker_order.trader, collateral));
                self.balances.write((taker_order.trader, collateral), taker_bal + cost - taker_fee);

                if taker_fee > 0 {
                    let fee_recipient = self.fee_recipient.read();
                    let fee_bal = self.balances.read((fee_recipient, collateral));
                    self.balances.write((fee_recipient, collateral), fee_bal + taker_fee);
                }
            } else {
                let taker_res = self.reserved.read((taker_order.trader, collateral));
                assert(taker_res >= cost + taker_fee, Errors::INSUFFICIENT_RESERVED);
                self
                    .reserved
                    .write((taker_order.trader, collateral), taker_res - cost - taker_fee);

                let maker_bal = self.balances.read((maker_order.trader, collateral));
                self.balances.write((maker_order.trader, collateral), maker_bal + cost);

                if taker_fee > 0 {
                    let fee_recipient = self.fee_recipient.read();
                    let fee_bal = self.balances.read((fee_recipient, collateral));
                    self.balances.write((fee_recipient, collateral), fee_bal + taker_fee);
                }
            }

            // Transfer ERC-1155 outcome tokens from seller to buyer.
            erc1155.safe_transfer_from(seller, buyer, maker_order.token_id, fill_amount, array![].span());

            // C5d: On-chain volume increment via MarketFactory.
            mf.increment_volume(maker_order.market_id.try_into().unwrap(), cost);

            self
                .emit(
                    TradeSettled {
                        maker: maker_order.trader,
                        taker: taker_order.trader,
                        market_id: maker_order.market_id,
                        token_id: maker_order.token_id,
                        fill_amount,
                        price: execution_price,
                        taker_fee,
                    },
                );
            self.reentrancy_guard.end();
        }

        fn cancel_order(ref self: ContractState, nonce: u256) {
            let caller = get_caller_address();
            assert(!self.nonces_used.read((caller, nonce)), Errors::NONCE_ALREADY_USED);
            self.nonces_used.write((caller, nonce), true);
            self.emit(OrderCancelled { user: caller, nonce });
        }

        /// C5f: Operator rotation (owner-only).
        fn set_operator(ref self: ContractState, new_operator: ContractAddress) {
            self.ownable.assert_only_owner();
            assert(!new_operator.is_zero(), Errors::ZERO_ADDRESS);
            let old_operator = self.operator.read();
            self.operator.write(new_operator);
            self.emit(OperatorUpdated { old_operator, new_operator });
        }

        /// C5f: Fee recipient rotation (owner-only).
        fn set_fee_recipient(ref self: ContractState, new_fee_recipient: ContractAddress) {
            self.ownable.assert_only_owner();
            assert(!new_fee_recipient.is_zero(), Errors::ZERO_ADDRESS);
            let old_recipient = self.fee_recipient.read();
            self.fee_recipient.write(new_fee_recipient);
            self.emit(FeeRecipientUpdated { old_recipient, new_recipient: new_fee_recipient });
        }

        /// C3: Configurable fees (owner-only, max 5%).
        fn set_fees(ref self: ContractState, maker_fee_bps: u256, taker_fee_bps: u256) {
            self.ownable.assert_only_owner();
            assert(maker_fee_bps <= MAX_FEE_BPS, Errors::FEE_TOO_HIGH);
            assert(taker_fee_bps <= MAX_FEE_BPS, Errors::FEE_TOO_HIGH);
            self.maker_fee_bps.write(maker_fee_bps);
            self.taker_fee_bps.write(taker_fee_bps);
            self.emit(FeesUpdated { maker_fee_bps, taker_fee_bps });
        }

        // -----------------------------------------------------------------
        //  Views
        // -----------------------------------------------------------------
        fn get_balance(
            self: @ContractState,
            user: ContractAddress,
            token: ContractAddress,
        ) -> u256 {
            self.balances.read((user, token))
        }

        fn get_reserved(
            self: @ContractState,
            user: ContractAddress,
            token: ContractAddress,
        ) -> u256 {
            self.reserved.read((user, token))
        }

        fn is_nonce_used(
            self: @ContractState,
            user: ContractAddress,
            nonce: u256,
        ) -> bool {
            self.nonces_used.read((user, nonce))
        }

        fn get_exchange_version(self: @ContractState) -> (felt252, felt252) {
            (CONTRACT_VERSION, 'mz-2026-03-04-p0fixes')
        }

        fn get_fees(self: @ContractState) -> (u256, u256) {
            (self.maker_fee_bps.read(), self.taker_fee_bps.read())
        }

        // -----------------------------------------------------------------
        //  Dark market support
        // -----------------------------------------------------------------

        fn register_dark_market(ref self: ContractState, market_id: u128) {
            self.pausable.assert_not_paused();
            let caller = get_caller_address();
            assert(caller == self.operator.read(), Errors::CALLER_NOT_OPERATOR);
            assert(!self.dark_markets.read(market_id), Errors::ALREADY_DARK);
            self.dark_markets.write(market_id, true);
            self.emit(DarkMarketRegistered { market_id });
        }

        fn is_dark_market(self: @ContractState, market_id: u128) -> bool {
            self.dark_markets.read(market_id)
        }

        fn settle_dark_trade(
            ref self: ContractState,
            market_id: u128,
            token_id: u256,
            fill_amount: u256,
            execution_price: u256,
            maker: ContractAddress,
            taker: ContractAddress,
            maker_is_buy: bool,
            trade_commitment: felt252,
        ) {
            self.pausable.assert_not_paused();
            self.reentrancy_guard.start();

            // Only operator can settle.
            let caller = get_caller_address();
            assert(caller == self.operator.read(), Errors::CALLER_NOT_OPERATOR);

            // Must be a registered dark market.
            assert(self.dark_markets.read(market_id), Errors::NOT_DARK_MARKET);

            assert(fill_amount > 0, Errors::FILL_ZERO);

            // C-2 fix: nonce-based replay protection via trade_commitment.
            assert(!self.dark_nonces_used.read(trade_commitment), Errors::DARK_NONCE_USED);
            self.dark_nonces_used.write(trade_commitment, true);

            // H-4 fix: reject self-trades.
            assert(maker != taker, Errors::SELF_TRADE);

            // Check market is still active (not past resolution_time, not voided).
            let mf = IMarketFactoryDispatcher {
                contract_address: self.market_factory.read(),
            };
            let market = mf.get_market(market_id.try_into().unwrap());
            assert(!market.voided, Errors::MARKET_VOIDED);
            let now_u64 = get_block_timestamp();
            assert(now_u64 < market.resolution_time, Errors::MARKET_CLOSED);

            // C-4 fix: validate token_id belongs to this market's condition.
            validate_token_id(market.condition_id, market.outcome_count, token_id);

            // Calculate fees (same math as settle_trade).
            let cost = (fill_amount * execution_price) / 1_000_000_000_000_000_000;
            // C-5 fix: prevent zero-cost trades.
            assert(cost > 0, Errors::ZERO_COST);
            let current_taker_fee_bps = self.taker_fee_bps.read();
            let taker_fee = (cost * current_taker_fee_bps) / BPS_DENOMINATOR;

            let collateral = market.collateral_token;
            let erc1155 = IERC1155Dispatcher {
                contract_address: self.conditional_tokens.read(),
            };

            let (buyer, seller) = if maker_is_buy {
                (maker, taker)
            } else {
                (taker, maker)
            };

            // Balance transfers — same logic as settle_trade.
            if maker_is_buy {
                // Maker is buying: deduct cost from maker's reserved, credit seller.
                let maker_res = self.reserved.read((maker, collateral));
                assert(maker_res >= cost, Errors::INSUFFICIENT_RESERVED);
                self.reserved.write((maker, collateral), maker_res - cost);

                let taker_bal = self.balances.read((taker, collateral));
                self.balances.write((taker, collateral), taker_bal + cost - taker_fee);

                if taker_fee > 0 {
                    let fee_recipient = self.fee_recipient.read();
                    let fee_bal = self.balances.read((fee_recipient, collateral));
                    self.balances.write((fee_recipient, collateral), fee_bal + taker_fee);
                }
            } else {
                // Taker is buying: deduct cost + fee from taker's reserved, credit maker.
                let taker_res = self.reserved.read((taker, collateral));
                assert(taker_res >= cost + taker_fee, Errors::INSUFFICIENT_RESERVED);
                self.reserved.write((taker, collateral), taker_res - cost - taker_fee);

                let maker_bal = self.balances.read((maker, collateral));
                self.balances.write((maker, collateral), maker_bal + cost);

                if taker_fee > 0 {
                    let fee_recipient = self.fee_recipient.read();
                    let fee_bal = self.balances.read((fee_recipient, collateral));
                    self.balances.write((fee_recipient, collateral), fee_bal + taker_fee);
                }
            }

            // Transfer ERC-1155 outcome tokens from seller to buyer.
            erc1155.safe_transfer_from(seller, buyer, token_id, fill_amount, array![].span());

            // Increment on-chain volume via MarketFactory.
            mf.increment_volume(market_id.try_into().unwrap(), cost);

            // Emit minimal event — no addresses, no prices, no sides.
            self.emit(DarkTradeSettled { market_id, trade_commitment, fill_amount });
            self.reentrancy_guard.end();
        }
    }

    // -----------------------------------------------------------------
    //  M-8: Post-resolution force release — users can unlock their own
    //  reservations after a market's resolution_time has passed.
    // -----------------------------------------------------------------
    #[abi(embed_v0)]
    impl ForceReleaseImpl of super::ICLOBForceRelease<ContractState> {
        fn force_release_after_resolution(
            ref self: ContractState,
            market_id: u64,
            token: ContractAddress,
            nonce: u256,
        ) {
            let caller = get_caller_address();
            let nonce_reserved = self.reservation_amounts.read((caller, nonce));
            assert(nonce_reserved > 0, Errors::NONCE_NO_RESERVATION);

            let reserved_token = self.reservation_tokens.read((caller, nonce));
            assert(reserved_token == token, Errors::TOKEN_MISMATCH);

            // M-8 fix: verify market_id matches the stored reservation market.
            let stored_market_id = self.reservation_market_ids.read((caller, nonce));
            assert(stored_market_id == market_id, Errors::MARKET_MISMATCH);

            // M-8 fix: verify market's resolution_time has passed or market is voided.
            let mf = IMarketFactoryDispatcher {
                contract_address: self.market_factory.read(),
            };
            let market = mf.get_market(market_id);
            let now = get_block_timestamp();
            assert(
                now >= market.resolution_time || market.voided,
                Errors::MARKET_CLOSED,
            );

            // Release full nonce amount back to available.
            let current_reserved = self.reserved.read((caller, token));
            assert(current_reserved >= nonce_reserved, Errors::INSUFFICIENT_RESERVED);

            self.reserved.write((caller, token), current_reserved - nonce_reserved);
            let available = self.balances.read((caller, token));
            self.balances.write((caller, token), available + nonce_reserved);

            // Clear nonce reservation tracking.
            self.reservation_amounts.write((caller, nonce), 0);
            self.reservation_expiries.write((caller, nonce), 0);

            self.emit(BalanceReleased { user: caller, token, amount: nonce_reserved });
        }
    }

    // -----------------------------------------------------------------
    //  Internal helpers
    // -----------------------------------------------------------------

    fn apply_fill(
        ref self: ContractState,
        trader: ContractAddress,
        nonce: u256,
        total_amount: u256,
        order_hash: felt252,
        fill_amount: u256,
    ) {
        let existing_hash = self.nonce_hash.read((trader, nonce));
        if existing_hash == 0 {
            self.nonce_hash.write((trader, nonce), order_hash);
            self.nonce_total.write((trader, nonce), total_amount);
            self.nonce_filled.write((trader, nonce), fill_amount);

            if fill_amount == total_amount {
                self.nonces_used.write((trader, nonce), true);
            }
            return;
        }

        assert(existing_hash == order_hash, Errors::ORDER_PARAMS_MISMATCH);
        let locked_total = self.nonce_total.read((trader, nonce));
        assert(locked_total == total_amount, Errors::ORDER_PARAMS_MISMATCH);

        let filled = self.nonce_filled.read((trader, nonce));
        let new_filled = filled + fill_amount;
        assert(new_filled <= locked_total, Errors::FILL_EXCEEDS_ORDER);
        self.nonce_filled.write((trader, nonce), new_filled);

        if new_filled == locked_total {
            self.nonces_used.write((trader, nonce), true);
        }
    }

    fn split_u256(value: u256) -> (felt252, felt252) {
        let low: felt252 = (value & 0xffffffffffffffffffffffffffffffff).try_into().unwrap();
        let high: felt252 = (value / 0x100000000000000000000000000000000).try_into().unwrap();
        (low, high)
    }

    fn hash_u256(value: u256) -> felt252 {
        let (low, high) = split_u256(value);
        PoseidonTrait::new()
            .update(U256_TYPE_HASH)
            .update(low)
            .update(high)
            .finalize()
    }

    fn compute_domain_hash(chain_id: felt252) -> felt252 {
        PoseidonTrait::new()
            .update(DOMAIN_TYPE_HASH)
            .update(DOMAIN_NAME)
            .update(DOMAIN_VERSION)
            .update(chain_id)
            .update(1) // revision — integer 1 to match starknet.js encoding
            .finalize()
    }

    fn compute_order_struct_hash(order: @Order) -> felt252 {
        PoseidonTrait::new()
            .update(ORDER_TYPE_HASH)
            .update((*order.trader).into())
            .update((*order.market_id).into())
            .update(hash_u256(*order.token_id))
            .update(if *order.is_buy { 1 } else { 0 })
            .update(hash_u256(*order.price))
            .update(hash_u256(*order.amount))
            .update(hash_u256(*order.nonce))
            .update((*order.expiry).into())
            .finalize()
    }

    fn hash_order(order: @Order) -> felt252 {
        let chain_id = get_tx_info().unbox().chain_id;
        let domain_hash = compute_domain_hash(chain_id);
        let struct_hash = compute_order_struct_hash(order);

        PoseidonTrait::new()
            .update(SNIP12_MESSAGE_PREFIX)
            .update(domain_hash)
            .update((*order.trader).into())
            .update(struct_hash)
            .finalize()
    }

    fn verify_signature(
        signer: ContractAddress,
        hash: felt252,
        signature: Span<felt252>,
    ) {
        let sig_array: Array<felt252> = signature.into();
        let result = ISRC6Dispatcher { contract_address: signer }
            .is_valid_signature(hash, sig_array);
        let is_valid = result == starknet::VALIDATED || result == 1;
        assert(is_valid, Errors::INVALID_SIGNATURE);
    }

    /// C-4 fix: validate that token_id is a valid outcome for condition_id.
    /// Uses the same Poseidon(condition_id, outcome_index) formula as ConditionalTokens.
    fn validate_token_id(condition_id: felt252, outcome_count: u32, token_id: u256) {
        let mut i: u32 = 0;
        let mut valid = false;
        while i < outcome_count {
            let expected = PoseidonTrait::new()
                .update(condition_id)
                .update(i.into())
                .finalize();
            let expected_u256: u256 = expected.into();
            if expected_u256 == token_id {
                valid = true;
                break;
            }
            i += 1;
        };
        assert(valid, Errors::INVALID_TOKEN_ID);
    }
}

// -----------------------------------------------------------------
//  Upgrade timelock interface (contract-local)
// -----------------------------------------------------------------
use starknet::class_hash::ClassHash;

#[starknet::interface]
pub trait ICLOBUpgradeTimelock<TContractState> {
    fn propose_upgrade(ref self: TContractState, new_class_hash: ClassHash);
    fn execute_upgrade(ref self: TContractState);
    fn cancel_upgrade(ref self: TContractState);
}

#[starknet::interface]
pub trait ICLOBPause<TContractState> {
    fn pause(ref self: TContractState);
    fn unpause(ref self: TContractState);
}

/// M-8: Allow users to force-release their own reservations.
use starknet::ContractAddress;

#[starknet::interface]
pub trait ICLOBForceRelease<TContractState> {
    fn force_release_after_resolution(
        ref self: TContractState,
        market_id: u64,
        token: ContractAddress,
        nonce: u256,
    );
}
