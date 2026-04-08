const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/vapi.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/@vapi-ai/web/dist/vapi.js'));
});

app.get('/api/vapi-key', (req, res) => {
  res.json({ key: process.env.VAPI_PUBLIC_KEY });
});

app.listen(PORT, () => {
  console.log(`Closer AI running on port ${PORT}`);
});
