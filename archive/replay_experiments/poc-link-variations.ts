import 'dotenv/config';
import { connect } from './connection.js';

async function testLinkVariations() {
  const sessionId = process.env.TV_SESSION_ID;
  console.log('\n🔗 Testando Variações de Link (Chart <-> Replay)...');
  
  const connection = await connect({ sessionId });
  console.log('✅ Conectado.');

  const replayId = 'rs_' + Math.random().toString(36).substring(2, 14);
  const symbol = 'CME_MINI:NQ1!';

  // 1. Setup Replay
  connection.send('replay_create_session', [replayId, '']);
  connection.send('replay_reset', [replayId, 'sds_sym_0', 1322694000]);

  // Variações para testar
  const variations = [
      { name: 'Prefix in Session', config: { symbol, session: `replay:${replayId}` } },
      { name: 'Raw Session ID', config: { symbol, session: replayId } }, // Falhou antes
      { name: 'Prefix in Symbol', config: { symbol: `replay:${replayId}:${symbol}`, session: 'regular' } },
      { name: 'Replay Param', config: { symbol, session: 'regular', replay: replayId } }
  ];

  let currentIdx = 0;

  connection.subscribe((event) => {
      // Ignorar erros do Replay
      if (event.name.startsWith('replay_')) return;

      if (event.name === 'symbol_resolved') {
          console.log(`🎉 SUCESSO! Link funcionou com: ${variations[currentIdx].name}`);
          process.exit(0);
      }
      
      if (event.name === 'symbol_error') {
          console.log(`❌ Falha (${variations[currentIdx].name}):`, event.params[2]);
          nextVariation();
      }
  });

  function nextVariation() {
      currentIdx++;
      if (currentIdx >= variations.length) {
          console.log('🏁 Todas as variações falharam.');
          process.exit(1);
      }
      testVariation();
  }

  function testVariation() {
      const v = variations[currentIdx];
      const cs = `cs_${currentIdx}_` + Math.random().toString(36).substring(2, 8);
      
      console.log(`\n👉 Tentando: ${v.name}`);
      connection.send('chart_create_session', [cs, '']);
      
      const configStr = `=${JSON.stringify({ 
          adjustment: 'splits', 
          'currency-id': 'USD', 
          ...v.config 
      })}`;
      
      connection.send('resolve_symbol', [cs, 'sds_sym_1', configStr]);
  }

  // Hook no start
  setTimeout(testVariation, 1000);
}

testLinkVariations();
