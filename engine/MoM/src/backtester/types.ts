export interface TradeRecord {
    entryTime: number;
    exitTime: number;
    entryPrice: number;
    exitPrice: number;
    isLong: boolean;
    pnl: number;
    riskR: number;         // 1R distance (structural stop size)
    rMultiple: number;     // P&L expressed as R multiples (pnl / riskR / dollarPerPoint)
    confidence: number;    // SMC probability at entry
    entryReason: string;   // why we entered
    exitReason: string;    // why we exited
}

export interface BacktestResult {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    netProfit: number;
    maxDrawdown: number;
    startingEquity: number;
    endingEquity: number;
    trades: TradeRecord[];
}

export interface WFOWindow {
    trainStart: Date;
    trainEnd: Date;
    testStart: Date;
    testEnd: Date;
    trainResult: BacktestResult;
    testResult: BacktestResult;
}

export interface WFOResult {
    windows: WFOWindow[];
    overallTestProfit: number;
    overallTestWinRate: number;
}
