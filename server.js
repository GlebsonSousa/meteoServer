const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// ✅ Carrega base de solo
const soloInfoPath = path.join(__dirname, 'solo_info.json');
let soloInfo = {};
try {
  soloInfo = JSON.parse(fs.readFileSync(soloInfoPath, 'utf8'));
} catch (e) {
  console.error('Erro ao carregar solo_info.json:', e);
}

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


// --- INÍCIO DA INTEGRAÇÃO DO MAPA DE SOLOS DETALHADO ---

const turf = require('@turf/turf'); // <-- 1. CERTIFIQUE-SE QUE ADICIONA ISTO NO TOPO

// --- [NOVO] Carregamento do Mapa de Solos Detalhado ---

// 2. Carrega o mapa de solos (arquivo grande) UMA VEZ na inicialização
let geoJsonSolos;
let geoJsonSolosCentroids; // <-- VARIÁVEL NOVA

try {
    const soloGeoJsonPath = path.join(__dirname, 'Solos_5000.json');
    if (fs.existsSync(soloGeoJsonPath)) {
        const soloData = fs.readFileSync(soloGeoJsonPath, 'utf8');
        geoJsonSolos = JSON.parse(soloData);
        console.log("SUCESSO: Mapa de solos 'Solos_5000.json' carregado.");
        // --- ADIÇÃO: Pré-calcula os centroides dos polígonos ---
        console.log("Calculando centroides dos polígonos de solo...");
        const centroids = geoJsonSolos.features.map(feature => {
            // Evita erros se a geometria for inválida
            if (!feature.geometry || !feature.geometry.coordinates || feature.geometry.coordinates.length === 0) {
                return null;
            }
            try {
                const centro = turf.centroid(feature.geometry);
                // Copia as propriedades (tipo de solo, etc.) do polígono para o seu ponto central
                centro.properties = feature.properties;
                return centro;
            } catch (centroidError) {
                console.warn("Aviso: Falha ao calcular centroide de um polígono.", centroidError.message);
                return null;
            }
        }).filter(Boolean); // Filtra os nulos/inválidos
        
        // Armazena a coleção de *pontos* (centroides) para busca rápida
        geoJsonSolosCentroids = turf.featureCollection(centroids);
        console.log(`SUCESSO: ${geoJsonSolosCentroids.features.length} centroides de solo calculados e prontos.`);
        // 

    } else {
        console.warn("AVISO: Arquivo 'Solos_5000.json' não encontrado. A rota /solo não funcionará.");
    }
} catch (e) {
    console.error('ERRO FATAL AO CARREGAR GeoJSON de solos:', e);
}

// 3. Carrega o dicionário de PROPRIEDADES de solo
let propriedadesSolos = {};
try {
    const propriedadesPath = path.join(__dirname, 'propriedades_solos.json');
    if (fs.existsSync(propriedadesPath)) {
        propriedadesSolos = JSON.parse(fs.readFileSync(propriedadesPath, 'utf8'));
        console.log("SUCESSO: 'propriedades_solos.json' (dicionário) carregado.");
    } else {
        console.warn('AVISO: Não foi possível carregar o dicionário propriedades_solos.json.');
    }
} catch (e) {
    console.warn('AVISO: Erro ao carregar propriedades_solos.json.', e);
}

// --- Rota /solo ---

app.get('/solo', (req, res) => {
    // 3. Valide se o arquivo de solos foi carregado
    console.log("Verificando disponibilidade dos dados de solos...");
    if (!geoJsonSolos || !geoJsonSolosCentroids) { // <-- Verifique as duas variáveis
        return res.status(503).json({ 
            erro: 'Serviço de solos indisponível (arquivo de dados não carregado).' 
        });
    }

    // 4. Obtenha e valide as coordenadas da query
    const { lat, lon } = req.query;
    if (!lat || !lon) {
        return res.status(400).json({ erro: 'Parâmetros "lat" e "lon" são obrigatórios.' });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);

    if (isNaN(latitude) || isNaN(longitude)) {
        return res.status(400).json({ erro: 'Valores de "lat" e "lon" inválidos.' });
    }

    // 5. Crie o "ponto" de busca do Turf
    const pontoClicado = turf.point([longitude, latitude]);
    
    let soloEncontrado = null;
    let metodoDeBusca = "Não encontrado";

    // 6. TENTATIVA 1: Faça a busca "Ponto em Polígono"
    for (const feature of geoJsonSolos.features) {
        try {
            if (turf.booleanPointInPolygon(pontoClicado, feature.geometry)) {
                soloEncontrado = feature.properties; // Salva as propriedades
                metodoDeBusca = "Busca Exata (Ponto em Polígono)";
                break; // Encontrou! Para o loop.
            }
        } catch(e) {
            // Ignora polígonos com geometria inválida
        }
    }

    // 7. TENTATIVA 2: Se não encontrou, busque o ponto mais próximo
    if (!soloEncontrado) {
        console.log("Aviso: Ponto fora dos polígonos. Buscando o centroide mais próximo...");
        // 
        // Usa os centroides pré-calculados para uma busca RÁPIDA
        const pontoMaisProximo = turf.nearestPoint(pontoClicado, geoJsonSolosCentroids);
        
        if (pontoMaisProximo) {
            soloEncontrado = pontoMaisProximo.properties; // Pega as propriedades do centroide
            metodoDeBusca = "Busca por Proximidade (Centroide)";
        }
    }

    // 8. Envie a resposta
    if (soloEncontrado) {
        
        // --- INÍCIO DA LÓGICA DE JUNÇÃO ---
        // Pega o nome do solo (ex: "Latossolo amarelo Distrófico")
        const tipoSoloNome = soloEncontrado.DSC_COMPON; 
        
        // Busca esse nome no dicionário (propriedadesSolos) que carregamos
        // 
        const propriedades = propriedadesSolos[tipoSoloNome] || {}; 
        
        // Junta os dados do GeoJSON com os dados do dicionário
        const dadosCompletos = {
            tipo_solo: tipoSoloNome,
            textura: soloEncontrado.DSC_TEXTUR || "-",
            associacao_1: soloEncontrado.DSC_COMPO1 || "-",
            associacao_2: soloEncontrado.DSC_COMPO2 || "-",
            fonte: 'Mapa Pedológico (GeoJSON)',
            
            // Dados "Enriquecidos" do arquivo propriedades_solos.json
            drenagem: propriedades.drenagem || "-",
            ph: propriedades.ph || "-",
            fertilidade: propriedades.fertilidade || "-",

            _metodo_de_busca: metodoDeBusca
        };

        return res.json(dadosCompletos);
        // --- FIM DA LÓGICA DE JUNÇÃO ---
        
    } else {
        // Se nem a busca exata nem a próxima funcionarem
        return res.status(404).json({ erro: 'Nenhum dado de solo encontrado para esta coordenada.' });
    }
});

// --- [O RESTO DO SEU CÓDIGO (ex: app.get('/chuva', ...), app.listen(...)) VEM DEPOIS] ---





// Rota principal
app.get('/', (req, res) => {
  res.send({ mensagem: 'Servidor meteorológico ativo!' });
});

// Rota estática
app.get('/tempo', (req, res) => {
  res.json({
    cidade: 'Rio de Janeiro',
    temperatura: 28,
    condição: 'Parcialmente nublado'
  });
});

app.get('/estupefato', (req, res) => {
  res.json({
    cidade: 69,
    temperatura: "Outro gato",
    condição: 'Aquele que tem dição.',
    pão: "sevenboys",
    ano: 1800
  });
});


// Rota /chuva com solo integrado
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
    estado: registro.estado,
    soma_chuva_mensal: somaChuvaPorMes,
  });
});

// Porta do servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
