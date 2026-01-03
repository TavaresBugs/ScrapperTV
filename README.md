# TradingView Scraper

Scraper para baixar dados históricos do TradingView via WebSocket.

## Instalação

```bash
npm install
```

## Uso

### Testar conexão

```bash
npm run cli -- --test
```

### Baixar dados

```bash
# BTCUSD 1H (10000 candles)
npm run cli -- -s BTCUSD -t 60 -a 10000

# MNQ 5min com autenticação Plus
npm run cli -- -s CME_MINI:MNQ1! -t 5 --session SEU_SESSION_ID

# XAUUSD diário
npm run cli -- -s OANDA:XAUUSD -t 1D
```

### Opções

| Opção             | Descrição                                    |
| ----------------- | -------------------------------------------- |
| `--symbol, -s`    | Símbolo (ex: BTCUSD, FX:EURUSD)              |
| `--timeframe, -t` | Timeframe: 1, 5, 15, 30, 60, 240, 1D, 1W, 1M |
| `--amount, -a`    | Quantidade de candles                        |
| `--session`       | SessionId do TradingView Plus                |
| `--output, -o`    | Diretório de saída (default: ./data)         |
| `--test`          | Testar conexão                               |
| `--debug, -d`     | Modo debug                                   |

## Como obter o SessionId

1. Faça login no [TradingView](https://tradingview.com) com sua conta Plus
2. Abra DevTools (F12) → Application → Cookies
3. Procure por `tradingview.com`
4. Copie o valor do cookie `sessionid`

## Formato dos dados

```json
{
  "symbol": "BTCUSD",
  "timeframe": "60",
  "downloadedAt": "2024-12-28T...",
  "count": 10000,
  "candles": [
    {
      "timestamp": 1703721600,
      "open": 42000.5,
      "high": 42150.0,
      "low": 41900.0,
      "close": 42100.0,
      "volume": 1234.5
    }
  ]
}
```

## Símbolos comuns

| Mercado | Símbolo                       |
| ------- | ----------------------------- |
| Bitcoin | BTCUSD, BINANCE:BTCUSDT       |
| Gold    | OANDA:XAUUSD, FOREXCOM:XAUUSD |
| EUR/USD | FX:EURUSD, OANDA:EURUSD       |
| MNQ     | CME_MINI:MNQ1!                |
| ES      | CME_MINI:ES1!                 |
