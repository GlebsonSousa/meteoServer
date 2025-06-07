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

    let dados;
    try {
      dados = JSON.parse(conteudo);
    } catch (erro) {
      console.error(`Erro ao parsear ${nomeArquivo}:`, erro);
      continue;
    }

    // 1º: Busca por código IBGE
    if (codigo_ibge) {
      for (const cidade in dados) {
        if (String(dados[cidade].codigo_ibge) === String(codigo_ibge)) {
          registro = { nome: cidade, ...dados[cidade] };
          break;
        }
      }
      if (registro) break;
    }

    // 2º: Busca por nome
    if (nome) {
      for (const cidade in dados) {
        if (cidade.toLowerCase() === nome.toLowerCase()) {
          registro = { nome: cidade, ...dados[cidade] };
          break;
        }
      }
      if (registro) break;
    }

    // 3º: Busca por coordenadas
    if (latitude !== null && longitude !== null) {
      for (const cidade in dados) {
        const item = dados[cidade];
        if (
          Math.abs(item.latitude - latitude) < tolerancia &&
          Math.abs(item.longitude - longitude) < tolerancia
        ) {
          registro = { nome: cidade, ...item };
          break;
        }
      }
    }

    if (registro) break;
  }

  if (!registro) {
    return res.status(404).json({ erro: 'Cidade não encontrada nos arquivos' });
  }

  // Calcula média mensal
  const valores = Object.values(registro.dados);
  const soma = valores.reduce((acc, val) => acc + val, 0);
  const media = valores.length > 0 ? soma / valores.length : 0;

  res.json({
    cidade: registro.nome,
    latitude: registro.latitude,
    longitude: registro.longitude,
    codigo_ibge: registro.codigo_ibge,
    media_chuva_mensal: media.toFixed(2)
  });
});
