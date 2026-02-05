<#
ask-llama.ps1 — Llama.cpp /completion (Llama 3 chat template) ✅
- Envia prompt no formato Llama 3 (system/user/assistant)
- Suporta stream (SSE/JSONL) e não-stream
- UTF-8 na saída (mata "Ã©")
- Anti-echo + delta-safe (não duplica quando o server manda "texto completo até agora")
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Prompt,

  [string]$Url = "http://localhost:8080/completion",

  [switch]$Stream,

  [ValidateScript({ ($_ -eq -1) -or ($_ -ge 16 -and $_ -le 32768) })]
  [int]$NPredict = 2000,

  [double]$Temperature = 0.8,
  [int]$TopK = 40,
  [double]$TopP = 0.95,
  [double]$TypicalP = 1.0,
  [double]$MinP = 0.05,

  [ValidateRange(0, 32768)]
  [int]$RepeatLastN = 64,

  [double]$RepeatPenalty = 1.0,
  [double]$PresencePenalty = 0.0,
  [double]$FrequencyPenalty = 0.0,

  [switch]$DebugFrames,
  [int]$MaxChars = 260
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# -------------------------
# UTF-8 console output
# -------------------------
try { chcp 65001 | Out-Null } catch {}
$script:outEnc = [System.Text.UTF8Encoding]::new($false)
try { [Console]::OutputEncoding = $script:outEnc } catch {}
$global:OutputEncoding = $script:outEnc
$script:stdout = [Console]::OpenStandardOutput()

function Write-Out([string]$s) {
  if ($null -eq $s) { return }
  $b = $script:outEnc.GetBytes($s)
  $script:stdout.Write($b, 0, $b.Length)
}
function Write-Line([string]$s="") { Write-Out ($s + "`n") }

# -------------------------
# Helpers
# -------------------------
function Has-Prop([object]$Obj, [string]$Name) {
  if ($null -eq $Obj) { return $false }
  return ($Obj.PSObject.Properties.Name -contains $Name)
}

function Get-Delta([object]$obj) {
  if ($null -eq $obj) { return $null }

  if (Has-Prop $obj "content" -and $obj.content) { return [string]$obj.content }

  if (Has-Prop $obj "choices" -and $obj.choices -and $obj.choices.Count -gt 0) {
    $c = $obj.choices[0]
    if (Has-Prop $c "delta" -and $c.delta -and (Has-Prop $c.delta "content") -and $c.delta.content) {
      return [string]$c.delta.content
    }
    if (Has-Prop $c "text" -and $c.text) { return [string]$c.text }
    if (Has-Prop $c "message" -and $c.message -and (Has-Prop $c.message "content") -and $c.message.content) {
      return [string]$c.message.content
    }
  }

  if (Has-Prop $obj "response" -and $obj.response) { return [string]$obj.response }
  return $null
}

function Is-Done([object]$obj) {
  if ($null -eq $obj) { return $false }
  foreach ($k in @("done","stop","stopped","isFinal","final")) {
    if (Has-Prop $obj $k) {
      try {
        $v = $obj.$k
        if ($v -is [bool] -and $v) { return $true }
        if ($v -is [string] -and $v.Trim().ToLowerInvariant() -in @("true","1","done","stop")) { return $true }
      } catch {}
    }
  }
  return $false
}

function Find-StopIndex([string]$text, [string[]]$markers) {
  if ([string]::IsNullOrEmpty($text)) { return -1 }
  if (-not $markers -or $markers.Count -eq 0) { return -1 }

  $best = -1
  foreach ($m in $markers) {
    if ([string]::IsNullOrWhiteSpace($m)) { continue }
    $i = $text.IndexOf($m, [System.StringComparison]::OrdinalIgnoreCase)
    if ($i -ge 0 -and ($best -lt 0 -or $i -lt $best)) { $best = $i }
  }
  return $best
}

# Remove qualquer eco do prompt caso o server devolva prompt+completion
function Strip-PromptEcho([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return $text }
  $marker = "<|start_header_id|>assistant<|end_header_id|>"
  $i = $text.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase)
  if ($i -ge 0) { return $text.Substring($i + $marker.Length).Trim() }
  return $text.Trim()
}

function Build-Llama3ChatPrompt([string]$system, [string]$user) {
  $sys = ($system -replace "`r","").Trim()
  $usr = ($user -replace "`r","").Trim()
  return @"
<|begin_of_text|><|start_header_id|>system<|end_header_id|>
$sys
<|eot_id|><|start_header_id|>user<|end_header_id|>
$usr
<|eot_id|><|start_header_id|>assistant<|end_header_id|>

"@
}

# -------------------------
# System prompt (fixo)
# -------------------------
$system = @"
Você é Leonel Dorneles Porto (eu), candidato em entrevista técnica.
REGRAS OBRIGATÓRIAS:
- Sempre PT-BR e sempre em primeira pessoa.
- NUNCA faça perguntas. NUNCA peça “faça a primeira pergunta”. NUNCA diga “começou a entrevista”. NUNCA diga “estou pronto”.
FORMATO:
- 1 único parágrafo.
- Exatamente 1 frase (uma frase só), encerrando com ponto final.
- Sem quebras de linha.
- Máximo de $MaxChars caracteres no total.
CONTEÚDO:
- Se for "me fale sobre você/vc": descreva cargo/foco/impacto de forma genérica e realista, sem métricas inventadas.
CONFIDENCIALIDADE:
- Não cite nomes, IDs, URLs, caminhos, tokens, chaves, ou dados internos.
"@.Trim()

# Stop padrão (o seu body que funcionou)
$stop = @("<|eot_id|>")

# -------------------------
# Build prompt
# -------------------------
$userText = ($Prompt -replace "`r","").Trim()
if ([string]::IsNullOrWhiteSpace($userText)) { throw "Prompt vazio." }

$finalPrompt = Build-Llama3ChatPrompt $system $userText

# -------------------------
# Request body
# -------------------------
$body = [ordered]@{
  prompt            = $finalPrompt
  stream            = [bool]$Stream
  echo              = $false
  n_predict         = $NPredict

  temperature       = $Temperature
  top_k             = $TopK
  top_p             = $TopP
  typical_p         = $TypicalP
  min_p             = $MinP

  repeat_last_n     = $RepeatLastN
  repeat_penalty    = $RepeatPenalty
  presence_penalty  = $PresencePenalty
  frequency_penalty = $FrequencyPenalty

  stop              = $stop
}

$bodyJson = $body | ConvertTo-Json -Compress -Depth 12
$utf8Body = [System.Text.UTF8Encoding]::new($false).GetBytes($bodyJson)

# -------------------------
# Non-stream
# -------------------------
if (-not $Stream) {
  $res = Invoke-RestMethod -Method Post -Uri $Url -Body $utf8Body -ContentType "application/json; charset=utf-8"
  $txt = Get-Delta $res
  if ([string]::IsNullOrEmpty($txt)) { $txt = ($res | ConvertTo-Json -Depth 20) }

  $txt = ($txt -replace "`r","" -replace "`n"," ").Trim()
  $txt = Strip-PromptEcho $txt

  $cut = Find-StopIndex $txt $stop
  if ($cut -ge 0) { $txt = $txt.Substring(0, $cut).Trim() }

  Write-Line $txt
  exit 0
}

# -------------------------
# Streaming (SSE/JSONL) + delta-safe
# -------------------------
Add-Type -AssemblyName System.Net.Http | Out-Null
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromMilliseconds(120000)

$req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $Url)
$req.Headers.Accept.Clear()
$req.Headers.Accept.Add((New-Object System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("text/event-stream")))
$req.Headers.Accept.Add((New-Object System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json")))

$req.Content = New-Object System.Net.Http.ByteArrayContent(,[byte[]]$utf8Body)
$req.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse("application/json; charset=utf-8")

$resp = $null
$reader = $null

$acc = ""
$printed = 0

try {
  $resp = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
  $resp.EnsureSuccessStatusCode() | Out-Null

  $reader = New-Object System.IO.StreamReader($resp.Content.ReadAsStreamAsync().Result, [System.Text.UTF8Encoding]::new($false), $true)

  while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    # ignora linhas SSE meta
    if ($line -match "^\s*event\s*:") { continue }
    if ($line -match "^\s*id\s*:")    { continue }
    if ($line -match "^\s*retry\s*:") { continue }
    if ($line -match "^\s*:")         { continue }

    $payload = if ($line -match "^\s*data:\s*(.*)$") { $Matches[1] } else { $line }
    if ([string]::IsNullOrWhiteSpace($payload)) { continue }

    $p = $payload.Trim()
    if ($p -eq "[DONE]") { break }

    if ($DebugFrames) { [Console]::Error.WriteLine($p) }

    $obj = $null
    try { $obj = $p | ConvertFrom-Json -ErrorAction Stop } catch { continue }

    $txt = Get-Delta $obj
    if ([string]::IsNullOrEmpty($txt)) {
      if (Is-Done $obj) { break }
      continue
    }

    # delta-safe:
    # - se vier "full text so far", substitui
    # - se vier chunk, concatena
    if ($txt.Length -ge $acc.Length -and $txt.StartsWith($acc)) {
      $acc = $txt
    } else {
      $acc += $txt
    }

    $accOneLine = ($acc -replace "`r","" -replace "`n"," ").Trim()
    $accOneLine = Strip-PromptEcho $accOneLine

    $cut = Find-StopIndex $accOneLine $stop
    if ($cut -ge 0) { $accOneLine = $accOneLine.Substring(0, $cut).Trim() }

    if ($accOneLine.Length -gt $printed) {
      Write-Out $accOneLine.Substring($printed)
      $printed = $accOneLine.Length
    }

    if ($cut -ge 0) { break }
    if (Is-Done $obj) { break }
  }

  Write-Line ""
}
finally {
  try { if ($reader) { $reader.Dispose() } } catch {}
  try { if ($resp)   { $resp.Dispose() } } catch {}
  try { if ($req)    { $req.Dispose() } } catch {}
  try { $client.Dispose() } catch {}
}
