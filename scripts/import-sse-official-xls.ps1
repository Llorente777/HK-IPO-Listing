param(
    [Parameter(Mandatory = $true)]
    [string]$MainBoardFile,

    [Parameter(Mandatory = $true)]
    [string]$StarMarketFile,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d{4}-\d{2}-\d{2}$')]
    [string]$AsOfDate,

    [string]$OutputRoot = "data/raw/official/a-share/manual"
)

$ErrorActionPreference = "Stop"

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Convert-ListingDate([string]$Value) {
    $digits = ($Value -replace '[^0-9]', '')
    if ($digits -match '^\d{8}$') {
        return $digits.Substring(0, 4) + "-" + $digits.Substring(4, 2) + "-" + $digits.Substring(6, 2)
    }
    return $null
}

function Open-ExcelApplication {
    for ($attempt = 1; $attempt -le 6; $attempt++) {
        try {
            $application = New-Object -ComObject Excel.Application -ErrorAction Stop
            $application.Visible = $false
            $application.DisplayAlerts = $false
            return $application
        }
        catch {
            if ($attempt -eq 6) { throw }
            Start-Sleep -Seconds 2
        }
    }
}

function Read-SseWorkbook {
    param(
        [Parameter(Mandatory = $true)]$Excel,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Board,
        [Parameter(Mandatory = $true)][string]$ExpectedCodePattern
    )

    $workbook = $Excel.Workbooks.Open($Path, 0, $true)
    try {
        if ($workbook.Worksheets.Count -ne 1) {
            throw "Expected one worksheet in $Path, found $($workbook.Worksheets.Count)"
        }
        $worksheet = $workbook.Worksheets.Item(1)
        try {
            $used = $worksheet.UsedRange
            try {
                $rowCount = [int]$used.Rows.Count
                $columnCount = [int]$used.Columns.Count
                $values = $used.Value2
                $headers = @{}
                for ($column = 1; $column -le $columnCount; $column++) {
                    $label = [string]$values.GetValue(1, $column)
                    if ($label) { $headers[$label.Trim()] = $column }
                }
                foreach ($required in @('A股代码', '证券简称', '扩位证券简称', '公司英文全称', '上市日期')) {
                    if (-not $headers.ContainsKey($required)) {
                        throw "Missing required column '$required' in $Path"
                    }
                }

                $records = [System.Collections.Generic.List[object]]::new()
                for ($row = 2; $row -le $rowCount; $row++) {
                    $code = ([string]$values.GetValue($row, $headers['A股代码'])).Trim()
                    if (-not $code) { continue }
                    $code = $code.PadLeft(6, '0')
                    if ($code -notmatch '^\d{6}$') {
                        throw "Invalid A-share code '$code' at row $row in $Path"
                    }
                    if ($code -notmatch $ExpectedCodePattern) {
                        throw "Unexpected $Board code '$code' at row $row in $Path"
                    }
                    $listingDate = Convert-ListingDate ([string]$values.GetValue($row, $headers['上市日期']))
                    $records.Add([PSCustomObject][ordered]@{
                        a_code = $code
                        exchange = 'SSE'
                        board = $Board
                        short_name = ([string]$values.GetValue($row, $headers['证券简称'])).Trim()
                        extended_name = ([string]$values.GetValue($row, $headers['扩位证券简称'])).Trim()
                        english_full_name = ([string]$values.GetValue($row, $headers['公司英文全称'])).Trim()
                        listing_date = $listingDate
                        official_url = "https://www.sse.com.cn/assortment/stock/list/info/company/index.shtml?COMPANY_CODE=$code"
                    })
                }
                return $records
            }
            finally {
                [void][Runtime.InteropServices.Marshal]::ReleaseComObject($used)
            }
        }
        finally {
            [void][Runtime.InteropServices.Marshal]::ReleaseComObject($worksheet)
        }
    }
    finally {
        $workbook.Close($false)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($workbook)
    }
}

$mainSource = (Resolve-Path -LiteralPath $MainBoardFile).Path
$starSource = (Resolve-Path -LiteralPath $StarMarketFile).Path
$asOf = [DateTime]::ParseExact($AsOfDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
$excel = Open-ExcelApplication
try {
    $mainRecords = Read-SseWorkbook -Excel $excel -Path $mainSource -Board '上交所主板' -ExpectedCodePattern '^6(?!88)'
    $starRecords = Read-SseWorkbook -Excel $excel -Path $starSource -Board '科创板' -ExpectedCodePattern '^68[89]'
}
finally {
    $excel.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

$records = @($mainRecords) + @($starRecords)
$duplicates = $records | Group-Object a_code | Where-Object Count -gt 1
if ($duplicates) {
    throw "Duplicate SSE codes found: $($duplicates.Name -join ', ')"
}
if ($mainRecords.Count -lt 1500 -or $starRecords.Count -lt 500) {
    throw "Unexpectedly small official export: main=$($mainRecords.Count), STAR=$($starRecords.Count)"
}
$futureRows = $records | Where-Object { $_.listing_date -and ([DateTime]$_.listing_date) -gt $asOf }
if ($futureRows) {
    throw "Official export contains listing dates after ${AsOfDate}: $($futureRows.a_code -join ', ')"
}

$destination = Join-Path $OutputRoot $AsOfDate
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$mainDestination = Join-Path $destination 'sse-main-board.xls'
$starDestination = Join-Path $destination 'sse-star-market.xls'
Copy-Item -LiteralPath $mainSource -Destination $mainDestination -Force
Copy-Item -LiteralPath $starSource -Destination $starDestination -Force

$payload = [ordered]@{
    schema_version = '1.0.0'
    as_of_date = $AsOfDate
    imported_at = (Get-Date).ToString('o')
    source = 'Shanghai Stock Exchange official stock list export'
    source_url = 'https://www.sse.com.cn/assortment/stock/list/share/'
    files = @(
        [ordered]@{
            board = '上交所主板'
            original_name = [IO.Path]::GetFileName($mainSource)
            local_file = ($mainDestination -replace '\\', '/')
            bytes = (Get-Item -LiteralPath $mainDestination).Length
            sha256 = Get-Sha256 $mainDestination
            downloaded_at = (Get-Item -LiteralPath $mainSource).LastWriteTime.ToString('o')
            record_count = $mainRecords.Count
        },
        [ordered]@{
            board = '科创板'
            original_name = [IO.Path]::GetFileName($starSource)
            local_file = ($starDestination -replace '\\', '/')
            bytes = (Get-Item -LiteralPath $starDestination).Length
            sha256 = Get-Sha256 $starDestination
            downloaded_at = (Get-Item -LiteralPath $starSource).LastWriteTime.ToString('o')
            record_count = $starRecords.Count
        }
    )
    record_count = $records.Count
    records = $records
}

$jsonPath = Join-Path $destination 'sse-official-universe.json'
$json = $payload | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path (Get-Location) $jsonPath), $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

[ordered]@{
    ok = $true
    as_of_date = $AsOfDate
    main_board_records = $mainRecords.Count
    star_market_records = $starRecords.Count
    total_records = $records.Count
    latest_listing_date = ($records.listing_date | Where-Object { $_ } | Sort-Object -Descending | Select-Object -First 1)
    output = $jsonPath
} | ConvertTo-Json
