import 'dotenv/config';
import { connect } from './connection.js';
import { RawCandle } from './types.js';
import fs from 'fs';
import path from 'path';

async function fetch2011Data() {
  const sessionId = process.env.TV_SESSION_ID;
  console.log('\n🚀 Iniciando Extração Final de 2011 (Protocolo Proven)...');
  
  const connection = await connect({ sessionId });
  console.log('✅ Conectado.');

  // Target: 05 Oct 2021 00:00 UTC (1633392000)
  const targetTime = 1633392000; 
  // const targetTime = 1322694000; // 2011 (Old)
  const chartSession = 'cs_' + Math.random().toString(36).substring(2, 14);
  const replaySession = 'rs_' + Math.random().toString(36).substring(2, 14);
  const symbol = 'CME_MINI:NQ1!';

  let replayReady = false;

  connection.subscribe((event) => {
    if (event.name === 'critical_error') {
       console.error('❌ CRITICAL:', event.params);
       process.exit(1);
    }

    // 1. Confirmação do Replay Reset
    if (event.name === 'replay_point') {
        const point = event.params[1];
        if (point === targetTime) {
            console.log('✅ Replay Point Confirmado (2011). Iniciando Chart...');
            replayReady = true;
            initChart();
        }
    }

    // 2. Confirmação do Link
    if (event.name === 'symbol_resolved') {
        console.log('✅ Símbolo Linkado com Sucesso!');
        requestData();
    }

    // 3. Dados!
    if(event.name === 'timescale_update') {
        const params = event.params as [string, Record<string, { s: RawCandle[] }>];
        const seriesData = params[1]?.['sds_1']?.s;
        if (seriesData && seriesData.length > 0) {
          console.log(`\n📊 DADOS RECEBIDOS: ${seriesData.length} candles`);
          const first = seriesData[0];
          const firstDate = new Date(first.v[0]*1000).toISOString();
          console.log(`   📅 Data do Primeiro Candle: ${firstDate} (${first.v[0]})`);
          
          if (Math.abs(first.v[0] - targetTime) < 86400 * 30) {
             console.log('🎉🎉🎉 SUCESSO TOTAL! DADOS DE 2011 CAPTURADOS! 🎉🎉🎉');
             saveData(seriesData);
             setTimeout(() => {
                 connection.close();
                 process.exit(0);
             }, 1000);
          } else {
             console.log('⚠️ Dados fora do alvo. Verifique se o replay foi resetado corretamente.');
          }
        }
    }
  });

  // PASSO A: Iniciar Replay
  console.log('1️⃣ Criando Sessão de Replay...');
  connection.send('replay_create_session', [replaySession, '']);
  connection.send('replay_reset', [replaySession, 'sds_sym_0', targetTime]);
  // Tentar "acordar" o replay
  setTimeout(() => {
      console.log('   ⏩ Envia replay_step para ativar...');
      connection.send('replay_step', [replaySession, 'sds_sym_0', 1]); 
  }, 500);

  function initChart() {
      console.log('2️⃣ Criando Sessão de Gráfico e Linkando...');
      connection.send('chart_create_session', [chartSession, '']);
      
      const config = JSON.stringify({ 
        symbol: symbol, 
        adjustment: 'splits', 
        session: `replay:${replaySession}` // <--- O SEGREDO!
      });

      connection.send('resolve_symbol', [chartSession, 'sds_sym_1', `=${config}`]);
  }

  function requestData() {
      console.log('3️⃣ Solicitando Dados...');
      connection.send('create_series', [
          chartSession,
          'sds_1',
          's1',
          'sds_sym_1',
          '15',
          300, 
          ''
      ]);
  }

  function saveData(data: RawCandle[]) {
     const dir = 'data/samples';
     if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
     const filePath = path.join(dir, '2011_proven_data.json');
     const formatted = data.map(c => ({
         time: new Date(c.v[0] * 1000).toISOString(),
         open: c.v[1], high: c.v[2], low: c.v[3], close: c.v[4], volume: c.v[5]
     }));
     fs.writeFileSync(filePath, JSON.stringify(formatted, null, 2));
     console.log(`💾 Arquivo salvo: ${filePath}`);
  }
}

fetch2011Data();
