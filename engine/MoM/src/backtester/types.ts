export interface TradeRecord {
    entryTime: number;
    exitTime: number;
    entryPrice: number;
    exitPrice: number;
    isLong: boolean;
    pnl: number;
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
