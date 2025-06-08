const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(cors());

// Função para logar cidades não encontradas
function logCidadeNaoEncontrada(nome, codigo_ibge) {
  const caminhoLog = path.join(__dirname, 'log_cidades.json');
  let logAtual = [];

  try {
    if (fs.existsSync(caminhoLog)) {
      const conteudo = fs.readFileSync(caminhoLog, 'utf8');
      logAtual = JSON.parse(conteudo);
    }
  } catch (erro) {
    console.error('Erro ao ler arquivo log_cidades.json:', erro);
  }

  const jaRegistrado = logAtual.some(
    item =>
      (nome && item.nome && item.nome.toLowerCase() === nome.toLowerCase()) &&
      (codigo_ibge && item.codigo_ibge === codigo_ibge)
  );

  if (!jaRegistrado) {
    logAtual.push({ nome: nome || null, codigo_ibge: codigo_ibge || null, data: new Date().toISOString() });
    try {
      fs.writeFileSync(caminhoLog, JSON.stringify(logAtual, null, 2), 'utf8');
    } catch (erro) {
      console.error('Erro ao escrever arquivo log_cidades.json:', erro);
    }
  }
}

// Função para calcular distância entre 2 coordenadas (Haversine)
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = angle => (Math.PI / 180) * angle;
  const R = 6371; // Raio da Terra em km

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.asin(Math.sqrt(a));
}

// Rota principal
app.get('/', (req, res) => {
  res.send({ mensagem: 'Servidor meteorológico ativo!' });
});

// Rota de exemplo estático
app.get('/tempo', (req, res) => {
  res.json({
    cidade: 'Rio de Janeiro',
    temperatura: 28,
    condição: 'Parcialmente nublado'
  });
});

// Rota /chuva com busca por codigo_ibge, nome, ou lat/lon
app.get('/chuva', (req, res) => {
  const { nome, lat, lon, codigo_ibge } = req.query;

  const latitude = lat ? parseFloat(lat) : null;
  const longitude = lon ? parseFloat(lon) : null;
  const tolerancia = 0.0001;

  const pastaDados = __dirname;
  const arquivos = fs.readdirSync(pastaDados).filter(arquivo =>
    arquivo.startsWith('chuva_parte_') && arquivo.endsWith('.json')
  );

  let registro = null;

  // Tenta encontrar registro exato primeiro
  for (const nomeArquivo of arquivos) {
    const caminho = path.join(pastaDados, nomeArquivo);
    const conteudo = fs.readFileSync(caminho, 'utf8');

    let dadosArquivo;
    try {
      dadosArquivo = JSON.parse(conteudo);
    } catch (erro) {
      console.error(`Erro ao parsear ${nomeArquivo}:`, erro);
      continue;
    }

    if (codigo_ibge) {
      for (const cidade in dadosArquivo) {
        if (String(dadosArquivo[cidade].codigo_ibge) === String(codigo_ibge)) {
          registro = { nome: cidade, ...dadosArquivo[cidade] };
          break;
        }
      }
      if (registro) break;
    }

    if (nome) {
      for (const cidade in dadosArquivo) {
        if (cidade.toLowerCase() === nome.toLowerCase()) {
          registro = { nome: cidade, ...dadosArquivo[cidade] };
          break;
        }
      }
      if (registro) break;
    }

    if (latitude !== null && longitude !== null) {
      for (const cidade in dadosArquivo) {
        const item = dadosArquivo[cidade];
        if (
          Math.abs(item.latitude - latitude) < tolerancia &&
          Math.abs(item.longitude - longitude) < tolerancia
        ) {
          registro = { nome: cidade, ...item };
          break;
        }
      }
      if (registro) break;
    }
  }

  // Se não encontrou, busca a cidade mais próxima (se lat/lon fornecido)
  if (!registro && latitude !== null && longitude !== null) {
    let cidadeMaisProxima = null;
    let menorDistancia = Infinity;

    for (const nomeArquivo of arquivos) {
      const caminho = path.join(pastaDados, nomeArquivo);
      const conteudo = fs.readFileSync(caminho, 'utf8');

      let dadosArquivo;
      try {
        dadosArquivo = JSON.parse(conteudo);
      } catch (erro) {
        continue;
      }

      for (const cidade in dadosArquivo) {
        const item = dadosArquivo[cidade];
        if (item.latitude == null || item.longitude == null) continue;

        const dist = haversine(latitude, longitude, item.latitude, item.longitude);

        if (dist < menorDistancia) {
          menorDistancia = dist;
          cidadeMaisProxima = { nome: cidade, ...item };
        }
      }
    }

    if (cidadeMaisProxima) {
      registro = cidadeMaisProxima;
    }
  }

  if (!registro) {
    logCidadeNaoEncontrada(nome, codigo_ibge);
    return res.status(404).json({ erro: 'Cidade não encontrada nos arquivos' });
  }

  const dadosDiarios = registro.dados;

  const somaPorMes = {};
  const contagemPorMes = {};

  for (const data in dadosDiarios) {
    const valor = Number(dadosDiarios[data]);
    if (isNaN(valor)) continue;

    const mesAno = data.slice(0, 7);

    somaPorMes[mesAno] = (somaPorMes[mesAno] || 0) + valor;
    contagemPorMes[mesAno] = (contagemPorMes[mesAno] || 0) + 1;
  }

  const mesesOrdenados = Object.keys(somaPorMes).sort((a, b) => b.localeCompare(a));
  const ultimos12Meses = mesesOrdenados.slice(0, 12).sort();

  const meses = {
    1: "Jan", 2: "Fev", 3: "Mar", 4: "Abr",
    5: "Mai", 6: "Jun", 7: "Jul", 8: "Ago",
    9: "Set", 10: "Out", 11: "Nov", 12: "Dez"
  };

  const somaChuvaPorMes = ultimos12Meses.map(mesAno => {
    const soma = somaPorMes[mesAno];
    const mesNum = Number(mesAno.slice(5, 7));

    return {
      mes: mesNum,
      nome_mes: meses[mesNum] || mesAno,
      ano_mes: mesAno,
      soma_mm: Number(soma.toFixed(2))
    };
  });

  return res.json({
    cidade: registro.nome,
    latitude: registro.latitude,
    longitude: registro.longitude,
    codigo_ibge: registro.codigo_ibge,
    soma_chuva_mensal: somaChuvaPorMes
  });
});


// Porta do servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
