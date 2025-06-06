const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send({ mensagem: "Servidor meteorológico ativo!" });
});

app.get("/tempo", (req, res) => {
  res.json({
    cidade: "Rio de Janeiro",
    temperatura: 28,
    condição: "Parcialmente nublado"
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
