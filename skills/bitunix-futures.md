# bitunix-futures — Bitunix USDT-M playbook

- Base: `https://fapi.bitunix.com`; public/private WebSocket URLs are configured separately.
- REST sign: `digest=SHA256(nonce+timestamp+apiKey+canonicalQuery+body-without-whitespace)`, `sign=SHA256(digest+secretKey)`. Sort query keys and concatenate `key+value` without `=`.
- Symbols: BTCUSDT style (no dash). Settlement coin: USDT.
- `place_order`: `symbol`, `side` BUY/SELL, `tradeSide` OPEN/CLOSE, `qty` (base coin, string), `price` (required for LIMIT), `orderType` LIMIT/MARKET, `effect` GTC/IOC/FOK/POST_ONLY.
- Hedge mode: `tradeSide` is required; CLOSE needs `positionId`.
- TP/SL: position-linked `POST /api/v1/futures/tpsl/position/place_order`; standalone `POST /api/v1/futures/tpsl/place_order`; cancel uses `/tpsl/cancel_order`.
- Account: `GET /api/v1/futures/account?marginCoin=USDT` returns the account list; select the exact requested coin.
- Private WebSocket: send one `{op:"login",args:[{apiKey,timestamp,nonce,sign}]}` frame, then subscribe with `{op:"subscribe",args:[{ch:"balance"},{ch:"position"},{ch:"order"},{ch:"tpsl"}]}`. Timestamp is Unix seconds; sign is `SHA256(SHA256(nonce+timestamp+apiKey)+secretKey)`.
- Public WebSocket subscriptions use `{ch, symbol, ...channelFields}`; heartbeat is `{op:"ping",ping:<Unix seconds>}`.
- Copy-trading asset endpoints are `/api/v1/cp/asset/query`, `/api/v1/cp/asset/transfer-to-sub-account`, and `/api/v1/cp/asset/transfer-to-main-account`; transfer bodies use `amount` and `assetType`.
- Paginated order/position/TP-SL responses use `orderList`/`positionList`/`tradeList` plus `total`; do not assume a bare array.
- Rate limits are endpoint-specific (commonly 10 req/sec/uid); batch where possible and keep scan intervals conservative.
