import { useState, useRef, useCallback } from 'react'
import { Upload, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { Chart as ChartJS, ArcElement, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from 'chart.js'
import { Doughnut, Bar } from 'react-chartjs-2'
import { uploadCursorCSV } from '../lib/api'
import { formatNumber, formatCost, formatDate } from '../lib/constants'
import { useTheme } from '../lib/theme'
import KpiCard from '../components/KpiCard'
import SectionTitle from '../components/SectionTitle'
import AnimatedLoader from '../components/AnimatedLoader'
import ChatSidebar from '../components/ChatSidebar'
import PageHeader from '../components/PageHeader'

ChartJS.register(ArcElement, CategoryScale, LinearScale, BarElement, Tooltip, Legend)

const MONO = 'JetBrains Mono, monospace'
const MODEL_COLORS = ['#6366f1', '#a78bfa', '#818cf8', '#c084fc', '#e879f9', '#f472b6', '#fb7185', '#f87171', '#fbbf24', '#34d399', '#2dd4bf', '#38bdf8', '#60a5fa', '#a3e635']

function ExperimentalTag() {
  return (
    <span
      className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
      style={{ background: 'rgba(234,179,8,0.12)', color: '#ca8a04', border: '1px solid rgba(234,179,8,0.25)' }}
    >
      experimental
    </span>
  )
}

export default function CursorCSVImport() {
  const { dark } = useTheme()
  const txtDim = dark ? '#555' : '#999'
  const legendColor = dark ? '#777' : '#555'
  const gridColor = dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.06)'

  const [stage, setStage] = useState('upload') // upload | loading | results
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [selectedChatId, setSelectedChatId] = useState(null)
  const [unmatchedOpen, setUnmatchedOpen] = useState(false)
  const fileRef = useRef(null)

  const handleFile = useCallback(async (file) => {
    if (!file || !file.name.endsWith('.csv')) {
      setError('Please select a CSV file')
      return
    }
    setError(null)
    setStage('loading')

    try {
      const text = await file.text()
      const result = await uploadCursorCSV(text)
      if (result.error) {
        setError(result.error)
        setStage('upload')
        return
      }
      setData(result)
      setStage('results')
    } catch (err) {
      setError(err.message || 'Upload failed')
      setStage('upload')
    }
  }, [])

  const onDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const onFileChange = useCallback((e) => {
    const file = e.target.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const resetUpload = () => {
    setStage('upload')
    setData(null)
    setError(null)
  }

  // ── Upload Stage ──
  if (stage === 'upload') {
    return (
      <div className="fade-in space-y-3">
        <PageHeader icon={Upload} title="Cursor CSV Import">
          <ExperimentalTag />
        </PageHeader>

        <div
          className="card p-8 flex flex-col items-center justify-center gap-3 cursor-pointer transition"
          style={{
            border: dragOver ? '2px dashed #6366f1' : '2px dashed var(--c-border)',
            background: dragOver ? 'rgba(99,102,241,0.05)' : 'transparent',
            minHeight: 220,
          }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
        >
          <Upload size={28} style={{ color: 'var(--c-text3)' }} />
          <div className="text-[13px] font-medium" style={{ color: 'var(--c-white)' }}>
            Drop your Cursor usage CSV here
          </div>
          <div className="text-[11px]" style={{ color: 'var(--c-text3)' }}>
            or click to browse
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={onFileChange}
          />
        </div>

        <div className="card p-3">
          <SectionTitle>how to get your CSV</SectionTitle>
          <ol className="text-[12px] space-y-1.5 list-decimal list-inside" style={{ color: 'var(--c-text2)' }}>
            <li>Go to <span className="font-mono" style={{ color: 'var(--c-white)' }}>cursor.com/settings</span></li>
            <li>Navigate to <span className="font-medium" style={{ color: 'var(--c-white)' }}>Usage</span> section</li>
            <li>Click <span className="font-medium" style={{ color: 'var(--c-white)' }}>Export CSV</span></li>
            <li>Upload the downloaded file here</li>
          </ol>
        </div>

        {error && (
          <div className="text-[12px] px-3 py-2 rounded" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444' }}>
            {error}
          </div>
        )}
      </div>
    )
  }

  // ── Loading Stage ──
  if (stage === 'loading') {
    return <AnimatedLoader label="Parsing CSV and matching sessions..." />
  }

  // ── Results Stage ──
  const { summary, sessionDetails, unmatched } = data
  const { modelBreakdown, dailyTrend, unknownModels } = summary

  // Charts — cost by model (estimated)
  const costBarData = modelBreakdown.filter(m => m.estimatedCost > 0).length > 0 ? {
    labels: modelBreakdown.slice(0, 12).map(m => m.model),
    datasets: [{
      data: modelBreakdown.slice(0, 12).map(m => Math.round(m.estimatedCost * 100) / 100),
      backgroundColor: MODEL_COLORS,
      borderRadius: 3,
    }],
  } : null

  // Charts — token bar
  const tokenBarData = modelBreakdown.length > 0 ? {
    labels: modelBreakdown.slice(0, 10).map(m => m.model),
    datasets: [
      {
        label: 'Input',
        data: modelBreakdown.slice(0, 10).map(m => m.inputTokens),
        backgroundColor: '#6366f1',
        borderRadius: 3,
      },
      {
        label: 'Output',
        data: modelBreakdown.slice(0, 10).map(m => m.outputTokens),
        backgroundColor: '#a78bfa',
        borderRadius: 3,
      },
      {
        label: 'Cache Read',
        data: modelBreakdown.slice(0, 10).map(m => m.cacheRead),
        backgroundColor: '#34d399',
        borderRadius: 3,
      },
    ],
  } : null

  const requestDoughnutData = modelBreakdown.length > 0 ? {
    labels: modelBreakdown.slice(0, 10).map(m => m.model),
    datasets: [{
      data: modelBreakdown.slice(0, 10).map(m => m.requestCount),
      backgroundColor: MODEL_COLORS,
      borderWidth: 0,
    }],
  } : null

  const doughnutOpts = {
    responsive: true, maintainAspectRatio: false, cutout: '55%',
    plugins: {
      legend: { position: 'right', labels: { color: legendColor, font: { size: 9, family: MONO }, usePointStyle: true, pointStyle: 'circle', padding: 6 } },
      tooltip: {
        bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 },
        callbacks: { label: ctx => ` ${ctx.label}: ${ctx.raw} requests` },
      },
    },
  }

  return (
    <div className="fade-in space-y-3">
      <PageHeader icon={Upload} title="Cursor CSV Import">
        <ExperimentalTag />
        <div className="ml-auto">
          <button
            onClick={resetUpload}
            className="px-2 py-1 text-[11px] rounded transition hover:bg-[var(--c-card)]"
            style={{ color: 'var(--c-text2)', border: '1px solid var(--c-border)' }}
          >
            Upload New CSV
          </button>
        </div>
      </PageHeader>

      {/* KPIs */}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))' }}>
        <KpiCard label="est. cost" value={formatCost(summary.totalEstimatedCost)} sub="from API pricing" />
        <KpiCard label="csv cost" value={summary.totalCost > 0 ? formatCost(summary.totalCost) : 'Included'} sub={`${summary.includedCount} included reqs`} />
        <KpiCard label="total requests" value={formatNumber(summary.totalRequests)} sub={`${summary.sessionCount} sessions matched`} />
        <KpiCard label="match rate" value={`${summary.matchRate}%`} sub={`${summary.matchedCount} / ${summary.totalRequests}`} />
        <KpiCard label="models" value={summary.uniqueModels} sub={unknownModels && unknownModels.length > 0 ? `${unknownModels.length} unpriced` : 'all priced'} />
        <KpiCard label="input tokens" value={formatNumber(summary.totalInput)} sub="total input" />
        <KpiCard label="output tokens" value={formatNumber(summary.totalOutput)} sub="total output" />
      </div>

      {/* Charts row 1: Cost by model + Request doughnut */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="card p-3 lg:col-span-2">
          <SectionTitle>est. cost by model</SectionTitle>
          {costBarData ? (
            <div style={{ height: 220 }}>
              <Bar
                data={costBarData}
                options={{
                  responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                  scales: {
                    x: { grid: { color: gridColor }, ticks: { color: txtDim, font: { size: 9, family: MONO }, callback: v => '$' + v } },
                    y: { grid: { display: false }, ticks: { color: legendColor, font: { size: 9, family: MONO } } },
                  },
                  plugins: {
                    legend: { display: false },
                    tooltip: {
                      bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 },
                      callbacks: { label: ctx => ` $${ctx.raw.toFixed(2)}` },
                    },
                  },
                }}
              />
            </div>
          ) : <div className="text-[11px] py-8 text-center" style={{ color: 'var(--c-text3)' }}>no cost data</div>}
        </div>
        <div className="card p-3">
          <SectionTitle>requests by model</SectionTitle>
          {requestDoughnutData ? (
            <div style={{ height: 220 }}>
              <Doughnut data={requestDoughnutData} options={doughnutOpts} />
            </div>
          ) : <div className="text-[11px] py-8 text-center" style={{ color: 'var(--c-text3)' }}>no data</div>}
        </div>
      </div>

      {/* Charts row 2: Tokens by model */}
      <div className="card p-3">
        <SectionTitle>tokens by model</SectionTitle>
        {tokenBarData ? (
          <div style={{ height: 220 }}>
            <Bar
              data={tokenBarData}
              options={{
                responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                scales: {
                  x: { stacked: true, grid: { color: gridColor }, ticks: { color: txtDim, font: { size: 9, family: MONO }, callback: v => formatNumber(v) } },
                  y: { stacked: true, grid: { display: false }, ticks: { color: legendColor, font: { size: 9, family: MONO } } },
                },
                plugins: {
                  legend: { labels: { color: legendColor, font: { size: 9, family: MONO }, usePointStyle: true, pointStyle: 'circle', padding: 8 } },
                  tooltip: {
                    bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 },
                    callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatNumber(ctx.raw)}` },
                  },
                },
              }}
            />
          </div>
        ) : <div className="text-[11px] py-8 text-center" style={{ color: 'var(--c-text3)' }}>no data</div>}
      </div>

      {/* Model breakdown table */}
      <div className="card overflow-hidden">
        <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <SectionTitle>model breakdown</SectionTitle>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider" style={{ borderBottom: '1px solid var(--c-border)', color: 'var(--c-text3)' }}>
                <th className="text-left py-2 px-3 font-medium">model</th>
                <th className="text-right py-2 px-3 font-medium">input tokens</th>
                <th className="text-right py-2 px-3 font-medium">output tokens</th>
                <th className="text-right py-2 px-3 font-medium">cache read</th>
                <th className="text-right py-2 px-3 font-medium">requests</th>
                <th className="text-right py-2 px-3 font-medium">est. cost</th>
                <th className="text-right py-2 px-3 font-medium">csv cost</th>
                <th className="text-right py-2 px-3 font-medium">% of total</th>
              </tr>
            </thead>
            <tbody>
              {modelBreakdown.map((m, i) => (
                <tr key={m.model} style={{ borderBottom: '1px solid var(--c-border)' }}>
                  <td className="py-2 px-3 font-mono font-medium" style={{ color: 'var(--c-white)' }}>
                    <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }} />
                    {m.model}
                    {m.normalizedModel && m.normalizedModel !== m.model.toLowerCase().replace(/\./g, '-') && (
                      <span className="text-[9px] ml-1.5" style={{ color: 'var(--c-text3)' }}>({m.normalizedModel})</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right font-mono" style={{ color: 'var(--c-text2)' }}>{formatNumber(m.inputTokens)}</td>
                  <td className="py-2 px-3 text-right font-mono" style={{ color: 'var(--c-text2)' }}>{formatNumber(m.outputTokens)}</td>
                  <td className="py-2 px-3 text-right font-mono" style={{ color: 'var(--c-text3)' }}>{m.cacheRead > 0 ? formatNumber(m.cacheRead) : '\u2014'}</td>
                  <td className="py-2 px-3 text-right font-mono" style={{ color: 'var(--c-text2)' }}>{m.requestCount}</td>
                  <td className="py-2 px-3 text-right font-mono font-medium" style={{ color: m.estimatedCost > 0 ? 'var(--c-white)' : 'var(--c-text3)' }}>
                    {m.estimatedCost > 0 ? formatCost(m.estimatedCost) : '\u2014'}
                  </td>
                  <td className="py-2 px-3 text-right font-mono" style={{ color: 'var(--c-text2)' }}>
                    {m.cost > 0 ? formatCost(m.cost) : ''}
                    {m.includedCount > 0 && <span className="text-[10px] ml-0.5" style={{ color: 'var(--c-text3)' }}>({m.includedCount} incl.)</span>}
                  </td>
                  <td className="py-2 px-3 text-right font-mono" style={{ color: 'var(--c-text3)' }}>
                    {summary.totalEstimatedCost > 0 ? ((m.estimatedCost / summary.totalEstimatedCost) * 100).toFixed(1) + '%' : '\u2014'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {modelBreakdown.length === 0 && (
          <div className="text-center py-8 text-sm" style={{ color: 'var(--c-text3)' }}>no model data</div>
        )}
      </div>

      {/* Matched sessions table */}
      {sessionDetails && sessionDetails.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--c-border)' }}>
            <SectionTitle>matched sessions ({sessionDetails.length})</SectionTitle>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider" style={{ borderBottom: '1px solid var(--c-border)', color: 'var(--c-text3)' }}>
                  <th className="text-left py-2 px-3 font-medium">name</th>
                  <th className="text-left py-2 px-3 font-medium">project</th>
                  <th className="text-left py-2 px-3 font-medium">model(s)</th>
                  <th className="text-right py-2 px-3 font-medium">requests</th>
                  <th className="text-right py-2 px-3 font-medium">input</th>
                  <th className="text-right py-2 px-3 font-medium">output</th>
                  <th className="text-right py-2 px-3 font-medium">est. cost</th>
                  <th className="text-right py-2 px-3 font-medium">csv cost</th>
                </tr>
              </thead>
              <tbody>
                {sessionDetails.slice(0, 50).map(s => (
                  <tr
                    key={s.composerId}
                    className="cursor-pointer transition"
                    style={{ borderBottom: '1px solid var(--c-border)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--c-bg3)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    onClick={() => setSelectedChatId(s.composerId)}
                  >
                    <td className="py-2 px-3 font-medium truncate max-w-[200px]" style={{ color: 'var(--c-white)' }}>
                      {s.name || <span style={{ color: 'var(--c-text3)' }}>Untitled</span>}
                    </td>
                    <td className="py-2 px-3 truncate max-w-[140px]" style={{ color: 'var(--c-text2)' }} title={s.folder}>
                      {s.folder ? s.folder.split('/').pop() : ''}
                    </td>
                    <td className="py-2 px-3 font-mono truncate max-w-[160px]" style={{ color: 'var(--c-text2)' }} title={s.models.join(', ')}>
                      {s.models.join(', ')}
                    </td>
                    <td className="py-2 px-3 text-right" style={{ color: 'var(--c-text3)' }}>{s.requestCount}</td>
                    <td className="py-2 px-3 text-right font-mono" style={{ color: 'var(--c-text2)' }}>{formatNumber(s.totalInput)}</td>
                    <td className="py-2 px-3 text-right font-mono" style={{ color: 'var(--c-text2)' }}>{formatNumber(s.totalOutput)}</td>
                    <td className="py-2 px-3 text-right font-mono font-medium" style={{ color: 'var(--c-white)' }}>
                      {s.totalEstimatedCost > 0 ? formatCost(s.totalEstimatedCost) : '\u2014'}
                    </td>
                    <td className="py-2 px-3 text-right font-mono" style={{ color: 'var(--c-text2)' }}>
                      {s.totalCost > 0 ? formatCost(s.totalCost) : 'Included'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Unknown models warning */}
      {unknownModels && unknownModels.length > 0 && (
        <div className="card p-3">
          <SectionTitle>
            <AlertTriangle size={11} className="inline mr-1" style={{ color: '#f59e0b' }} />
            unpriced models ({unknownModels.length})
          </SectionTitle>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {unknownModels.map(m => (
              <span key={m} className="text-[11px] px-2 py-0.5 font-mono" style={{ background: 'rgba(245,158,11,0.08)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.2)' }}>
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Unmatched rows (collapsible) */}
      {unmatched && unmatched.length > 0 && (
        <div className="card overflow-hidden">
          <div
            className="px-3 py-2 flex items-center gap-2 cursor-pointer"
            style={{ borderBottom: unmatchedOpen ? '1px solid var(--c-border)' : 'none' }}
            onClick={() => setUnmatchedOpen(!unmatchedOpen)}
          >
            {unmatchedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <SectionTitle>unmatched rows ({unmatched.length})</SectionTitle>
          </div>
          {unmatchedOpen && (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider" style={{ borderBottom: '1px solid var(--c-border)', color: 'var(--c-text3)' }}>
                    <th className="text-left py-2 px-3 font-medium">date</th>
                    <th className="text-left py-2 px-3 font-medium">model</th>
                    <th className="text-right py-2 px-3 font-medium">input</th>
                    <th className="text-right py-2 px-3 font-medium">output</th>
                    <th className="text-right py-2 px-3 font-medium">est. cost</th>
                    <th className="text-right py-2 px-3 font-medium">csv cost</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatched.slice(0, 100).map((row, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--c-border)' }}>
                      <td className="py-2 px-3 whitespace-nowrap" style={{ color: 'var(--c-text2)' }}>{formatDate(row.timestamp)}</td>
                      <td className="py-2 px-3 font-mono" style={{ color: 'var(--c-white)' }}>{row.model}</td>
                      <td className="py-2 px-3 text-right font-mono" style={{ color: 'var(--c-text2)' }}>{formatNumber(row.inputTokens)}</td>
                      <td className="py-2 px-3 text-right font-mono" style={{ color: 'var(--c-text2)' }}>{formatNumber(row.outputTokens)}</td>
                      <td className="py-2 px-3 text-right font-mono" style={{ color: 'var(--c-white)' }}>{row.estimatedCost ? formatCost(row.estimatedCost) : '\u2014'}</td>
                      <td className="py-2 px-3 text-right font-mono" style={{ color: 'var(--c-text2)' }}>{row.cost != null ? formatCost(row.cost) : 'Included'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Chat sidebar */}
      <ChatSidebar chatId={selectedChatId} onClose={() => setSelectedChatId(null)} />
    </div>
  )
}
