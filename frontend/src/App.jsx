import { useState } from 'react'

function App() {
  const [inputText, setInputText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [results, setResults] = useState([])

  async function handleAnalyze() {
    setIsLoading(true)
    setResults([])

    const response = await fetch('http://localhost:3000/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: inputText })
    })

    const data = await response.json()
    setResults(data.results)
    setIsLoading(false)
  }

  return (
    <div style={{ maxWidth: '700px', margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>Veristate</h1>
      <p>Paste text below and get each claim fact-checked.</p>

      <textarea
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
        rows={6}
        style={{ width: '100%', padding: '10px', fontSize: '16px' }}
        placeholder="Paste a claim, article, or speech excerpt..."
      />

      <button
        onClick={handleAnalyze}
        disabled={isLoading || !inputText}
        style={{ marginTop: '10px', padding: '10px 20px', fontSize: '16px' }}
      >
        {isLoading ? 'Analyzing...' : 'Analyze'}
      </button>

      <div style={{ marginTop: '30px' }}>
        {results.map((r, i) => (
          <div
            key={i}
            style={{
              border: '1px solid #ccc',
              borderRadius: '8px',
              padding: '15px',
              marginBottom: '15px'
            }}
          >
            <strong>{r.claim}</strong>
            <p>
              Verdict: <b>{r.verdict}</b> ({r.confidence}% confidence)
            </p>
            <p>{r.reasoning}</p>
            <div>
              {r.sources.map((s, j) => (
                <div key={j}>
                  <a href={s} target="_blank" rel="noreferrer">{s}</a>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default App