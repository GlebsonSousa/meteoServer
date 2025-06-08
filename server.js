const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(cors());

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

  if (!registro) {
    return res.status(404).json({ erro: 'Cidade não encontrada nos arquivos' });
  }

  const dadosDiarios = registro.dados;

  // Acumula soma e contagem diária agrupando por mês (formato "YYYY-MM")
  const somaPorMes = {};
  const contagemPorMes = {};

  for (const data in dadosDiarios) {
    const valor = Number(dadosDiarios[data]);
    if (isNaN(valor)) continue;

    const mesAno = data.slice(0, 7); // "YYYY-MM"

    somaPorMes[mesAno] = (somaPorMes[mesAno] || 0) + valor;
    contagemPorMes[mesAno] = (contagemPorMes[mesAno] || 0) + 1;
  }

  // Ordena meses do mais recente para o mais antigo
  const mesesOrdenados = Object.keys(somaPorMes).sort((a, b) => b.localeCompare(a));

  // Pega os últimos 6 meses e ordena cronologicamente (ascendente)
  const ultimos6Meses = mesesOrdenados.slice(0, 6).sort();

  // Mapeia número do mês para nome abreviado
  const meses = {
    1: "Jan", 2: "Fev", 3: "Mar", 4: "Abr",
    5: "Mai", 6: "Jun", 7: "Jul", 8: "Ago",
    9: "Set", 10: "Out", 11: "Nov", 12: "Dez"
  };

  // Monta array de médias mensais com nome do mês e valor em mm
  const mediasPorMes = ultimos6Meses.map(mesAno => {
    const media = somaPorMes[mesAno] / contagemPorMes[mesAno];
    const mesNum = Number(mesAno.slice(5, 7));

    return {
      mes: mesNum,
      nome_mes: meses[mesNum] || mesAno,
      ano_mes: mesAno,
      media_mm: Number(media.toFixed(2))
    };
  });

  return res.json({
    cidade: registro.nome,
    latitude: registro.latitude,
    longitude: registro.longitude,
    codigo_ibge: registro.codigo_ibge,
    media_chuva_mensal: mediasPorMes
  });
});

// Porta do servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
