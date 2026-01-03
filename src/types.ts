/**
 * Candle/Bar data structure
 */
export interface Candle {
  timestamp: number;
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Raw candle from TradingView
 */
export interface RawCandle {
  i: number;
  v: number[];
}

/**
 * Timeframes suportados pelo TradingView
 */
export type Timeframe = 1 | 3 | 5 | 15 | 30 | 45 | 60 | 120 | 180 | 240 | '1D' | '1W' | '1M';

/**
 * Tipos de Endpoint do TradingView
 */
export type Endpoint = 'prodata' | 'data' | 'history';

/**
 * Tipos de Conexão
 */
export type ConnectionType = 'chart' | 'quote' | 'history';

/**
 * Opções de conexão
 */
export interface ConnectionOptions {
  sessionId?: string;
  debug?: boolean;
  endpoint?: Endpoint;
  connectionType?: ConnectionType;
  autoReconnect?: boolean;
}

/**
 * Evento do TradingView
 */
export interface TradingViewEvent {
  name: string;
  params: unknown[];
}

/**
 * Subscriber para eventos
 */
export type Subscriber = (event: TradingViewEvent) => void;

/**
 * Função para cancelar subscription
 */
export type Unsubscriber = () => void;

/**
 * Conexão com TradingView
 */
export interface TradingViewConnection {
  subscribe: (handler: Subscriber) => Unsubscriber;
  send: (name: string, params: unknown[]) => void;
  close: () => Promise<void>;
  isConnected: () => boolean;
}

/**
 * Parâmetros para buscar candles
 */
export interface GetCandlesParams {
  connection: TradingViewConnection;
  symbol: string;
  timeframe?: Timeframe;
  amount?: number;
  from?: number;
  to?: number;
}

/**
 * Dados para salvar em arquivo
 */
export interface SavedData {
  symbol: string;
  timeframe: string;
  downloadedAt: string;
  count: number;
  candles: Candle[];
}
