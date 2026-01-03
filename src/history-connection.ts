import { connect } from './connection.js';
import type { ConnectionOptions, TradingViewConnection } from './types.js';

/**
 * Conecta ao endpoint de histórico do TradingView
 * Usado para backtesting e dados antigos
 */
export async function connectHistory(
  options: Omit<ConnectionOptions, 'endpoint' | 'connectionType'> = {}
): Promise<TradingViewConnection> {
  return connect({
    ...options,
    endpoint: 'history',
    connectionType: 'chart',
  });
}
