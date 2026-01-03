import WebSocket from 'ws';
import type {
  ConnectionOptions,
  TradingViewConnection,
  TradingViewEvent,
  Subscriber,
  Unsubscriber,
  Endpoint,
  ConnectionType,
} from './types.js';

const HOSTS = {
  prodata: 'prodata.tradingview.com',
  data: 'data.tradingview.com',
  history: 'history-data.tradingview.com',
};

type MessageType = 'ping' | 'session' | 'event';

interface MessagePayload {
  type: MessageType;
  data: unknown;
}

/**
 * Parse mensagens do TradingView
 */
function parseMessage(message: string): MessagePayload[] {
  if (message.length === 0) return [];

  const events = message.toString().split(/~m~\d+~m~/).slice(1);

  return events.map((event) => {
    // Heartbeat ping
    if (event.substring(0, 3) === '~h~') {
      return { type: 'ping' as const, data: `~m~${event.length}~m~${event}` };
    }

    // JSON message (~j~)
    if (event.substring(0, 3) === '~j~') {
      try {
        const parsed = JSON.parse(event.substring(3));
        if (parsed['session_id']) {
          return { type: 'session' as const, data: parsed };
        }
        return { type: 'event' as const, data: parsed };
      } catch (e) {
        console.warn('Falha ao parsear mensagem JSON:', event);
        return { type: 'event' as const, data: {} };
      }
    }

    // Fallback para JSON direto (legado)
    try {
      const parsed = JSON.parse(event);
      if (parsed['session_id']) {
        return { type: 'session' as const, data: parsed };
      }
      return { type: 'event' as const, data: parsed };
    } catch (e) {
      return { type: 'event' as const, data: {} };
    }
  });
}

/**
 * Formata mensagem para enviar
 */
function formatMessage(name: string, params: unknown[]): string {
  const data = JSON.stringify({ m: name, p: params });
  return `~m~${data.length}~m~${data}`;
}

/**
 * Gera string aleatória para IDs de sessão
 */
function randomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Obtém auth token do TradingView
 */
async function getAuthToken(sessionId: string): Promise<string> {
  try {
    const response = await fetch('https://www.tradingview.com/disclaimer/', {
      headers: {
        Cookie: `sessionid=${sessionId}`,
      },
    });
    const html = await response.text();
    const match = html.match(/"auth_token":"(.+?)"/);
    if (match) {
      return match[1];
    }
  } catch (error) {
    console.error('Erro ao obter auth_token:', error);
  }
  return 'unauthorized_user_token';
}

/**
 * Prepara URL do WebSocket
 */
function prepareUrl(
  endpoint: Endpoint = 'prodata',
  connectionType: ConnectionType = 'chart'
): string {
  const host = HOSTS[endpoint];
  const url = new URL(`wss://${host}/socket.io/websocket`);
  
  url.searchParams.append('from', '/chart/');
  url.searchParams.append('date', new Date().toISOString().split('T')[0]);
  url.searchParams.append('type', connectionType);

  return url.toString();
}

/**
 * Conecta ao WebSocket do TradingView
 */
export async function connect(options: ConnectionOptions = {}): Promise<TradingViewConnection> {
  const { 
    sessionId, 
    debug = false, 
    endpoint = 'prodata', 
    connectionType = 'chart',
    autoReconnect = true
  } = options;

  let ws: WebSocket | null = null;
  let token = 'unauthorized_user_token';
  const subscribers: Set<Subscriber> = new Set();
  let connected = false;
  let reconnectAttempts = 0;
  let manuallyClosed = false;
  let connectionPromiseCallback: { resolve: (conn: TradingViewConnection) => void, reject: (err: Error) => void } | null = null;
  let resolveConnection: ((conn: TradingViewConnection) => void) | null = null;

  async function initConnection(): Promise<void> {
    if (sessionId) {
      if (debug) console.log('🔐 Autenticando com sessionId...');
      token = await getAuthToken(sessionId);
      if (token !== 'unauthorized_user_token') {
        if (debug) console.log('✅ Autenticação bem-sucedida!');
      } else {
        if (debug) console.warn('⚠️ Usando modo não autenticado');
      }
    }

    const url = prepareUrl(endpoint, connectionType);
    if (debug) console.log(`🔌 Conectando a ${url}...`);

    const headers: Record<string, string> = {
      'Origin': 'https://www.tradingview.com',
    };

    if (sessionId) {
      headers['Cookie'] = `sessionid=${sessionId}`;
    }

    ws = new WebSocket(url, {
      headers,
    });

    ws.on('open', () => {
      if (debug) console.log('📡 Socket aberto');
      reconnectAttempts = 0;
    });

    ws.on('close', () => {
      connected = false;
      if (debug) console.log('❌ Socket fechado');
      
      if (autoReconnect && !manuallyClosed) {
        const delay = Math.min(5000 * Math.pow(1.5, reconnectAttempts), 60000);
        reconnectAttempts++;
        console.log(`🔄 Reconectando em ${delay}ms (tentativa ${reconnectAttempts})...`);
        setTimeout(() => initConnection(), delay);
      }
    });

    ws.on('error', (error) => {
      console.error('🔥 Erro no WebSocket:', error);
      if (connectionPromiseCallback) {
        connectionPromiseCallback.reject(error);
      }
    });

    ws.on('message', (message) => {
      const payloads = parseMessage(message.toString());

      for (const payload of payloads) {
        switch (payload.type) {
          case 'ping':
            ws?.send(payload.data as string);
            break;

          case 'session':
            send('set_auth_token', [token]);
            connected = true;
            if (debug) console.log('🔗 Sessão estabelecida');
            if (resolveConnection) {
              resolveConnection({ subscribe, send, close, isConnected });
              resolveConnection = null;
            }
            break;

          case 'event':
            const eventData = payload.data as { m: string; p: unknown[] };
            if (debug && eventData.m !== 'qsd') { // Ignorar flood de quotes
              console.log('📥 Evento:', eventData.m);
            }
            const event: TradingViewEvent = {
              name: eventData.m,
              params: eventData.p,
            };
            subscribers.forEach((handler) => handler(event));
            break;
        }
      }
    });
  }

  function subscribe(handler: Subscriber): Unsubscriber {
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  }

  function send(name: string, params: unknown[]) {
    if (ws?.readyState === WebSocket.OPEN) {
      if (debug && name !== 'quote_set_fields') {
        console.log('📤 Enviando:', name, params);
      }
      ws.send(formatMessage(name, params));
    } else {
      console.warn('⚠️ Tentativa de envio com socket fechado:', name);
    }
  }

  async function close(): Promise<void> {
    manuallyClosed = true;
    return new Promise((resolve) => {
      if (ws) {
        ws.once('close', () => resolve());
        ws.close();
      } else {
        resolve();
      }
    });
  }

  function isConnected(): boolean {
    return connected;
  }

  return new Promise<TradingViewConnection>((resolve, reject) => {
    connectionPromiseCallback = { resolve, reject };
    resolveConnection = resolve;
    initConnection().catch(reject);
    
    // Timeout inicial de conexão apenas
    setTimeout(() => {
      if (!connected && resolveConnection) {
        reject(new Error('Timeout ao conectar com TradingView'));
        resolveConnection = null;
      }
    }, 30000);
  });
}

/**
 * Gera ID para chart session
 */
export function generateChartSession(): string {
  return 'cs_' + randomString(12);
}

/**
 * Gera ID para quote session
 */
export function generateQuoteSession(): string {
  return 'qs_' + randomString(12);
}
