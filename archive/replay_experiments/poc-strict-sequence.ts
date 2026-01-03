import 'dotenv/config';
import { connect } from './connection.js';
import { RawCandle } from './types.js';

async function testStrictSequence() {
  const sessionId = process.env.TV_SESSION_ID;
  console.log('\n🧪 Testando Sequência Estrita do Log do Usuário...');
  
  const connection = await connect({ sessionId });
  console.log('✅ Conectado.');

  const cs = 'cs_' + Math.random().toString(36).substring(2, 14);
  const qs = 'qs_' + Math.random().toString(36).substring(2, 14);
  const symbol = 'CME_MINI:NQ1!';

  // Helper para JSON stringify no formato TV
  const symConfig = (s: string) => `=${JSON.stringify({ 
      adjustment: 'splits', 
      backadjustment: 'default', 
      'currency-id': 'USD', 
      session: 'regular', 
      'settlement-as-close': false, 
      symbol: s 
  })}`;

  connection.subscribe((event) => {
    if (event.name === 'timescale_update') {
      const params = event.params as [string, Record<string, { s: RawCandle[] }>];
      const s = params[1]?.['sds_1']?.s;
      if (s) {
          console.log(`📊 DADOS RECEBIDOS: ${s.length} candles`);
          console.log(`   📅 Primeiro: ${new Date(s[0].v[0]*1000).toISOString()}`);
          process.exit(0);
      }
    }
  });

  // SEQUÊNCIA EXATA DO LOG
  console.log('1. chart_create_session');
  connection.send('chart_create_session', [cs, '']);

  console.log('2. quote_create_session');
  connection.send('quote_create_session', [qs]);

  console.log('3. quote_set_fields');
  connection.send('quote_set_fields', [qs, "base-currency-logoid","ch","chp","currency-logoid","currency_code","currency_id","base_currency_id","current_session","description","exchange","format","fractional","is_tradable","language","local_description","listed_exchange","logoid","lp","lp_time","minmov","minmove2","original_name","pricescale","pro_name","short_name","type","typespecs","update_mode","volume","variable_tick_size","value_unit_id","unit_id","measure"]);

  console.log('4. quote_add_symbols');
  connection.send('quote_add_symbols', [qs, symConfig(symbol)]);

  console.log('5. resolve_symbol');
  connection.send('resolve_symbol', [cs, 'sds_sym_1', symConfig(symbol)]);

  console.log('6. create_series');
  // TENTATIVA: Inserir o range AQUI, mas mantendo o resto igual
  // Mas primeiro, vamos testar o padrão (últimos 300) para ver se funciona igual ao browser
  connection.send('create_series', [
      cs,
      'sds_1',
      's1',
      'sds_sym_1',
      '15',
      300, 
      `r,${1322611200}:${1322697600}` 
  ]);

  console.log('7. quote_fast_symbols');
  connection.send('quote_fast_symbols', [qs, symConfig(symbol)]);
}

testStrictSequence();
