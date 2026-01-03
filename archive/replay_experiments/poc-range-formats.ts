import 'dotenv/config';
import { connect } from './connection.js';
import { RawCandle } from './types.js';

async function testRangeFormats() {
  const sessionId = process.env.TV_SESSION_ID;
  console.log('\n🧪 Testando Formatos de Range no create_series...');
  
  const connection = await connect({ sessionId });
  console.log('✅ Conectado.');

  const chartSession = 'cs_' + Math.random().toString(36).substring(2, 14);
  const symbol = 'CME_MINI:NQ1!';
  
  // Target: Nov 2011
  const from = 1322611200; // 2011-11-30 00:00
  const to   = 1322697600; // 2011-11-31 00:00

  // 4 Formatos para testar sequencialmente
  const formats = [
    { name: 'Format A (String in Last Arg)', args: [chartSession, 'sds_1', 's1', 'sds_sym_1', '15', 0, `r,${from}:${to}`] },
    { name: 'Format B (String in Count Arg)', args: [chartSession, 'sds_2', 's2', 'sds_sym_1', '15', `r,${from}:${to}`, ''] },
    { name: 'Format C (Range Object)',        args: [chartSession, 'sds_3', 's3', 'sds_sym_1', '15', { from, to }, ''] }, // Já falhou, mas tentando limpo
    { name: 'Format D (JSON String in Last)', args: [chartSession, 'sds_4', 's4', 'sds_sym_1', '15', 0, JSON.stringify({from, to})] }
  ];

  let currentFormatIndex = 0;

  connection.subscribe((event) => {
    if (event.name === 'critical_error' || event.name === 'error') {
       console.log(`❌ Erro no formato ${formats[currentFormatIndex].name}:`, event.params);
       tryNextFormat();
    }
    
    if(event.name === 'timescale_update') {
      const params = event.params as [string, Record<string, { s: RawCandle[] }>];
      const seriesId = `sds_${currentFormatIndex + 1}`;
      const seriesData = params[1]?.[seriesId]?.s;
      
      if (seriesData && seriesData.length > 0) {
        console.log(`🎉 SUCESSO com formato: ${formats[currentFormatIndex].name}`);
        console.log(`   📊 ${seriesData.length} candles recebidos.`);
        console.log(`   📅 Primeiro: ${new Date(seriesData[0].v[0]*1000).toISOString()}`);
        process.exit(0);
      }
    }
  });

  function tryNextFormat() {
    currentFormatIndex++;
    if (currentFormatIndex >= formats.length) {
      console.log('🏁 Todos os formatos falharam.');
      process.exit(1);
    }
    sendCurrentFormat();
  }

  function sendCurrentFormat() {
    const fmt = formats[currentFormatIndex];
    console.log(`\n👉 Tentando: ${fmt.name}`);
    
    // Precisamos recriar a sessão ou série para isolar?
    // Vamos tentar criar série nova no mesmo chart session
    connection.send('create_series', fmt.args);
  }

  // Setup padrão
  console.log('1️⃣ Setup Inicial...');
  connection.send('chart_create_session', [chartSession, '']);
  connection.send('resolve_symbol', [
      chartSession,
      'sds_sym_1',
      `=${JSON.stringify({ symbol, adjustment: 'splits', session: 'regular' })}`
  ]);

  setTimeout(() => {
    sendCurrentFormat();
  }, 1000);
}

testRangeFormats();
