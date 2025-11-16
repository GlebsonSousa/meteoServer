const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const turf = require('@turf/turf'); // Para análise geoespacial
const axios = require('axios');   // Para chamar a API ISRIC

const app = express();
app.use(cors());

// --- Carregamento dos Dados (Início) ---

// 1. Carrega base de solo SIMPLES (por Estado)
const soloInfoPath = path.join(__dirname, 'solo_info.json');
let soloInfo = {};
try {
  soloInfo = JSON.parse(fs.readFileSync(soloInfoPath, 'utf8'));
  console.log("SUCESSO: 'solo_info.json' carregado.");
} catch (e) {
  console.error('Erro ao carregar solo_info.json:', e);
}

// 2. Carrega o MAPA de solos (GeoJSON)
let geoJsonSolos;
let geoJsonSolosCentroids; // Armazena os pontos centrais

try {
    const soloGeoJsonPath = path.join(__dirname, 'Solos_5000.json'); 
    if (fs.existsSync(soloGeoJsonPath)) {
        const soloData = fs.readFileSync(soloGeoJsonPath, 'utf8');
        geoJsonSolos = JSON.parse(soloData);
        console.log("SUCESSO: Mapa de solos 'Solos_5000.json' carregado.");
        
        // Pré-calcula os centroides dos polígonos
        console.log("Calculando centroides dos polígonos de solo...");
        const centroids = geoJsonSolos.features.map(feature => {
            if (!feature.geometry || !feature.geometry.coordinates || feature.geometry.coordinates.length === 0) {
                return null;
            }
            try {
                const centro = turf.centroid(feature.geometry);
                centro.properties = feature.properties;
                return centro;
            } catch (centroidError) {
                console.warn("Aviso: Falha ao calcular centroide de um polígono.", centroidError.message);
                return null;
            }
        }).filter(Boolean); 
        
        geoJsonSolosCentroids = turf.featureCollection(centroids);
        console.log(`SUCESSO: ${geoJsonSolosCentroids.features.length} centroides de solo calculados.`);

    } else {
        console.warn("AVISO: Arquivo 'Solos_5000.json' não encontrado. A rota /solo não funcionará.");
    }
} catch (e) {
    console.error('ERRO FATAL AO CARREGAR GeoJSON de solos:', e);
}

// 3. Carrega o DICIONÁRIO de propriedades (pH, Drenagem, etc.)
let propriedadesSolos = {};
try {
    const propriedadesPath = path.join(__dirname, 'FertDrenPH.json'); 
    if (fs.existsSync(propriedadesPath)) {
        propriedadesSolos = JSON.parse(fs.readFileSync(propriedadesPath, 'utf8'));
        console.log("SUCESSO: 'FertDrenPH.json' (dicionário) carregado.");
    } else {
        console.warn('AVISO: Não foi possível carregar o dicionário FertDrenPH.json.');
    }
} catch (e) {
    console.warn('AVISO: Erro ao carregar FertDrenPH.json.', e);
}

// 4. Carrega a BASE DE CONHECIMENTO de Culturas
let culturasDB = {};
try {
    const culturasPath = path.join(__dirname, 'culturas_db.json');
    if (fs.existsSync(culturasPath)) {
        culturasDB = JSON.parse(fs.readFileSync(culturasPath, 'utf8'));
        console.log("SUCESSO: 'culturas_db.json' (Cérebro) carregado.");
    } else {
        console.warn('AVISO: Não foi possível carregar o dicionário culturas_db.json.');
    }
} catch (e) {
    console.warn('AVISO: Erro ao carregar culturas_db.json.', e);
}

// --- Fim do Carregamento dos Dados ---


// --- Funções Auxiliares ---

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

// Função para buscar dados precisos de pH, Matéria Orgânica e Argila da API ISRIC
async function buscarDadosPrecisosSolo(lat, lon) {
    const url = `https://rest.isric.org/soilgrids/v2.0/query?lon=${lon}&lat=${lat}&properties=phh2o,ocd,clay&depths=0-5cm&units=g/kg`;
    try {
        const response = await axios.get(url);
        if (!response.data || !response.data.properties || !response.data.properties.layers) {
            throw new Error("Resposta da API ISRIC incompleta.");
        }
        const properties = response.data.properties;
        const getMean = (propName) => {
            const layer = properties.layers.find(l => l.name === propName);
            if (layer && layer.depths && layer.depths[0] && layer.depths[0].values && layer.depths[0].values.mean !== undefined) {
                const mean = layer.depths[0].values.mean;
                // A ISRIC armazena valores convertidos
                if (propName === 'phh2o') return (mean / 10).toFixed(1); // pH
                if (propName === 'ocd') return (mean / 100).toFixed(2);  // Matéria Orgânica (g/kg -> %)
                if (propName === 'clay') return (mean / 10).toFixed(1); // Argila (g/kg -> %)
            }
            return null;
        };
        return {
            ph_preciso: getMean('phh2o'),
            materia_organica_percent: getMean('ocd'),
            argila_percent: getMean('clay')
        };
    } catch (error) {
        console.warn(`AVISO: Falha ao buscar dados da API ISRIC SoilGrids: ${error.message}`);
        return null; // Retorna null se a API falhar
    }
}

// Função para buscar dados de chuva (Refatorada DA SUA rota /chuva original)
function buscarDadosChuva(latitude, longitude, nome, codigo_ibge, soloInfoDb) {
  const tolerancia = 0.0001;
  const pastaDados = __dirname;
  const arquivos = fs.readdirSync(pastaDados).filter(arquivo =>
    arquivo.startsWith('chuva_parte_') && arquivo.endsWith('.json')
  );
  let registro = null;

  // (Lógica de busca exata)
  for (const nomeArquivo of arquivos) {
    const caminho = path.join(pastaDados, nomeArquivo);
    const conteudo = fs.readFileSync(caminho, 'utf8');
    let dadosArquivo;
    try { dadosArquivo = JSON.parse(conteudo); } catch (erro) { continue; }

    if (codigo_ibge) {
      for (const cidade in dadosArquivo) {
        if (String(dadosArquivo[cidade].codigo_ibge) === String(codigo_ibge)) {
          registro = { nome: cidade, ...dadosArquivo[cidade] }; break;
        }
      }
      if (registro) break;
    }
    if (nome) {
      for (const cidade in dadosArquivo) {
        if (cidade.toLowerCase() === nome.toLowerCase()) {
          registro = { nome: cidade, ...dadosArquivo[cidade] }; break;
        }
      }
      if (registro) break;
    }
    if (latitude !== null && longitude !== null) {
      for (const cidade in dadosArquivo) {
        const item = dadosArquivo[cidade];
        if (Math.abs(item.latitude - latitude) < tolerancia && Math.abs(item.longitude - longitude) < tolerancia) {
          registro = { nome: cidade, ...item }; break;
        }
      }
      if (registro) break;
    }
  }

  // (Lógica de busca por proximidade - Haversine)
  if (!registro && latitude !== null && longitude !== null) {
    let cidadeMaisProxima = null;
    let menorDistancia = Infinity;
    for (const nomeArquivo of arquivos) {
      const caminho = path.join(pastaDados, nomeArquivo);
      const conteudo = fs.readFileSync(caminho, 'utf8');
      let dadosArquivo;
      try { dadosArquivo = JSON.parse(conteudo); } catch (erro) { continue; }
      for (const cidade in dadosArquivo) {
        const item = dadosArquivo[cidade];
        if (item.latitude == null || item.longitude == null) continue;
public:
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
    return { erro: 'Cidade não encontrada nos arquivos de chuva' }; // Retorna objeto de erro
  }

  // Processamento dos dados de chuva
  const dadosDiarios = registro.dados;
  const somaPorMes = {};
  for (const data in dadosDiarios) {
    const valor = Number(dadosDiarios[data]);
    if (isNaN(valor)) continue;
    const mesAno = data.slice(0, 7);
    somaPorMes[mesAno] = (somaPorMes[mesAno] || 0) + valor;
  }
  const mesesOrdenados = Object.keys(somaPorMes).sort((a, b) => b.localeCompare(a));
  const ultimos12Meses = mesesOrdenados.slice(0, 12).sort();
  const meses = { 1: "Jan", 2: "Fev", 3: "Mar", 4: "Abr", 5: "Mai", 6: "Jun", 7: "Jul", 8: "Ago", 9: "Set", 10: "Out", 11: "Nov", 12: "Dez" };
  const somaChuvaPorMes = ultimos12Meses.map(mesAno => {
    const soma = somaPorMes[mesAno];
    const mesNum = Number(mesAno.slice(5, 7));
    return { mes: mesNum, nome_mes: meses[mesNum] || mesAno, ano_mes: mesAno, soma_mm: Number(soma.toFixed(2)) };
  });
  const chuvaTotalAnual = somaChuvaPorMes.reduce((acc, mes) => acc + mes.soma_mm, 0);

  // Busca o solo simples (para o clima)
  const dadosSolo = soloInfoDb[registro.estado] || null;

  // Retorna o objeto de dados completo
  return {
    cidade_proxima: registro.nome,
    latitude: registro.latitude,
    longitude: registro.longitude,
    codigo_ibge: registro.codigo_ibge,
    estado: registro.estado,
    soma_chuva_mensal: somaChuvaPorMes,
    chuva_total_anual_mm: chuvaTotalAnual,
    solo: dadosSolo // Retorna o solo simples, como o front-end antigo espera
  };
}

// --- Fim das Funções Auxiliares ---


// --- ROTAS DA APLICAÇÃO ---

app.get('/', (req, res) => {
  res.send({ mensagem: 'Servidor meteorológico ativo!' });
});

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


// --- Rota /solo (A ROTA PRINCIPAL DE ANÁLISE) ---

app.get('/solo', async (req, res) => { // Rota agora é ASYNC
    
    // 1. Valide se os arquivos essenciais foram carregados
    console.log("Verificando disponibilidade dos dados de solos...");
    if (!geoJsonSolos || !geoJsonSolosCentroids || !propriedadesSolos || !culturasDB) { 
        return res.status(503).json({ 
            erro: 'Serviço de recomendação indisponível (arquivos de dados não carregados).' 
        });
    }

    // 2. Obtenha e valide as coordenadas da query
    const { lat, lon } = req.query;
    if (!lat || !lon) {
        return res.status(400).json({ erro: 'Parâmetros "lat" e "lon" são obrigatórios.' });
    }
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    if (isNaN(latitude) || isNaN(longitude)) {
        return res.status(400).json({ erro: 'Valores de "lat" e "lon" inválidos.' });
    }

    // --- Início da Lógica de Análise ---
    const pontoClicado = turf.point([longitude, latitude]);
    let soloEncontradoProps = null;
    let metodoDeBusca = "Não encontrado";

    // 3. [SÍNCRONO] Busca o solo local no GeoJSON
    // TENTATIVA 1: Busca Exata
    for (const feature of geoJsonSolos.features) {
        try {
            if (turf.booleanPointInPolygon(pontoClicado, feature.geometry)) {
                soloEncontradoProps = feature.properties;
                metodoDeBusca = "Busca Exata";
                break; 
            }
        } catch(e) {}
    }

    // TENTATIVA 2: Busca por Proximidade
    if (!soloEncontradoProps) {
        console.log("Aviso: Ponto fora dos polígonos. Buscando o centroide mais próximo...");
        const pontoMaisProximo = turf.nearestPoint(pontoClicado, geoJsonSolosCentroids);
        if (pontoMaisProximo) {
            soloEncontradoProps = pontoMaisProximo.properties; 
            metodoDeBusca = "Busca por Proximidade";
        }
    }
    
    if (!soloEncontradoProps) {
        return res.status(404).json({ erro: 'Nenhum dado de solo local encontrado para esta coordenada.' });
    }

    // 4. [SÍNCRONO] Enriquece o solo local com o dicionário
    const tipoSoloNome = soloEncontradoProps.DSC_COMPON; 
    const propriedades = propriedadesSolos[tipoSoloNome] || {}; 
    const dadosLocaisSolo = {
        tipo_solo: tipoSoloNome,
        textura: soloEncontradoProps.DSC_TEXTUR || "-",
        drenagem: propriedades.drenagem || "Não informada",
        ph: propriedades.ph || 0, // 0 como padrão se indefinido
        fertilidade: propriedades.fertilidade || "Desconhecida",
is     _metodo_de_busca: metodoDeBusca
    };

    // 5. [AÇÕES PARALELAS] Busca Chuva (Local) e Solo Preciso (API)
    let dadosChuva = {};
    let dadosPrecisos = null;

    try {
        // A função buscarDadosChuva é síncrona (usa readFileSync)
        dadosChuva = buscarDadosChuva(latitude, longitude, null, null, soloInfo); 

        // A função buscarDadosPrecisosSolo é assíncrona (usa await axios)
        console.log("Buscando dados precisos da ISRIC API...");
        dadosPrecisos = await buscarDadosPrecisosSolo(latitude, longitude);

    } catch (error) {
        console.error("Erro ao buscar dados externos (Chuva ou ISRIC):", error.message);
    }
    
    // --- 6. LÓGICA DE RECOMENDAÇÃO (SCORING) - O "CRUZAMENTO DE DADOS" ---
    const recomendacoes = [];

    // Cria o "Contexto Atual" com os melhores dados disponíveis
    const dadosAtuais = {
        // Usa o pH preciso da API se ele existir, senão usa o pH genérico do dicionário
        ph: (dadosPrecisos && dadosPrecisos.ph_preciso) ? parseFloat(dadosPrecisos.ph_preciso) : parseFloat(dadosLocaisSolo.ph),
        drenagem: dadosLocaisSolo.drenagem,
        // (A API ISRIC não tem 'fertilidade', usamos a do dicionário local)
        fertilidade: dadosLocaisSolo.fertilidade,
        chuva_anual: (dadosChuva && dadosChuva.chuva_total_anual_mm) ? dadosChuva.chuva_total_anual_mm : 0,
        // Dados precisos da API para pontuação avançada
        argila: (dadosPrecisos && dadosPrecisos.argila_percent) ? parseFloat(dadosPrecisos.argila_percent) : 0,
        mo: (dadosPrecisos && dadosPrecisos.materia_organica_percent) ? parseFloat(dadosPrecisos.materia_organica_percent) : 0
    };

    console.log("Dados Atuais para Scoring:", dadosAtuais);

    if (dadosAtuais.chuva_anual > 0 && culturasDB) { // Só faz recomendação se tiver chuva E a base de culturas
        for (const [nomeCultura, condicoes] of Object.entries(culturasDB)) {
            let score = 0;

            // Verifica se a cultura tem as condições definidas
            const c = condicoes; // Apelido
            
            // A. Pontuar pH (Peso 2)
            if (c.ph_range && dadosAtuais.ph >= c.ph_range[0] && dadosAtuais.ph <= c.ph_range[1]) {
                score += 2;
            }

            // B. Pontuar Drenagem (Peso 1)
            if (c.drenagem_ideal && c.drenagem_ideal.includes(dadosAtuais.drenagem)) {
                score += 1;
            }

            // C. Pontuar Chuva (Peso 1)
            if (c.chuva_range_mm && dadosAtuais.chuva_anual >= c.chuva_range_mm[0] && dadosAtuais.chuva_anual <= c.chuva_range_mm[1]) {
                score += 1;
            }

            // D. Pontuar Argila (Peso 1) - Se a API tiver retornado
            if (c.argila_range_percent && dadosAtuais.argila > 0) {
                 if (dadosAtuais.argila >= c.argila_range_percent[0] && dadosAtuais.argila <= c.argila_range_percent[1]) {
                    score += 1;
                }
            }
            
            // E. Pontuar Matéria Orgânica (Fertilidade) (Peso 2) - Se a API tiver retornado
            if (c.mo_range_percent && dadosAtuais.mo > 0) {
                 if (dadosAtuais.mo >= c.mo_range_percent[0] && dadosAtuais.mo <= c.mo_range_percent[1]) {
                    score += 2;
                }
            }
            // Fallback para 'fertilidade' genérica se a API falhar
            else if (c.fertilidade && !c.mo_range_percent && dadosAtuais.mo === 0) {
                 if (c.fertilidade.includes(dadosAtuais.fertilidade)) {
                    score += 1; // Score menor por ser genérico
                 }
            }

            recomendacoes.push({ 
                nome: nomeCultura, 
                score: score, 
                categoria: c.categoria || "N/A"
            });
        }
    }

    // Ordenar do melhor (maior score) para o pior
    const topRecomendacoes = recomendacoes.sort((a, b) => b.score - a.score).slice(0, 3);
    
    console.log("Top 3:", topRecomendacoes);

    // 7. Envie a Resposta Completa
    return res.json({
        solo_local: dadosLocaisSolo,    // Dados do seu GeoJSON + Dicionário
        solo_preciso: dadosPrecisos,   // Novos dados da API ISRIC
        chuva: dadosChuva.erro ? { erro: dadosChuva.erro } : dadosChuva, // Dados de chuva (que agora contém o 'solo' simples)
        recomendacoes: topRecomendacoes // Top 3 culturas
    });
});


// --- Rota /chuva (Simples, apenas chama a função) ---
app.get('/chuva', (req, res) => {
  const { nome, lat, lon, codigo_ibge } = req.query;
  const latitude = lat ? parseFloat(lat) : null;
  const longitude = lon ? parseFloat(lon) : null;

  // Chama a função de busca síncrona e passa o 'soloInfo'
  const dadosChuva = buscarDadosChuva(latitude, longitude, nome, codigo_ibge, soloInfo);

  if (dadosChuva.erro) {
      return res.status(404).json({ erro: dadosChuva.erro });
  } else {
      return res.json(dadosChuva);
  }
});

// --- Porta do servidor ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});