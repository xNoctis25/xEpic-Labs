import { RiskEngine } from './RiskEngine';
import { ExecutionEngine } from './ExecutionEngine';
import { CandleAggregator, Candle, Tick } from '../market/CandleAggregator';
import { BreakoutExpert } from '../experts/BreakoutExpert';
import { PullbackExpert } from '../experts/PullbackExpert';
import { TradovateBroker } from '../brokers/TradovateBroker';

export class MoMEngine {
    private riskEngine: RiskEngine;
    private executionEngine: ExecutionEngine;
    private broker: TradovateBroker;
    
    private aggregator: CandleAggregator;
    private breakoutExpert: BreakoutExpert;
    private pullbackExpert: PullbackExpert;
    
    private symbolToTrade = 'MESM6'; // Micro E-Mini S&P 500 June 2026 Contract

    constructor(broker: TradovateBroker) {
        this.broker = broker;
        this.riskEngine = new RiskEngine();
        this.executionEngine = new ExecutionEngine();
        
        this.breakoutExpert = new BreakoutExpert();
        this.pullbackExpert = new PullbackExpert();

        // Build 1-minute candles from the tick stream
        this.aggregator = new CandleAggregator(1, this.onCandleComplete.bind(this));
    }

    public async start(): Promise<void> {
        console.log("🚀 [MoMEngine] - Central Orchestrator Online. Booting sub-systems...");
        
        const connected = await this.broker.connect();
        if (connected) {
            // Once connected, subscribe to the data stream and pipe it into the aggregator
            this.broker.subscribeMarketData(this.symbolToTrade, (tick: Tick) => {
                if (this.riskEngine.canTrade()) {
                    this.aggregator.processTick(tick);
                }
            });
        }
    }

    private onCandleComplete(candle: Candle): void {
        console.log(`📊 [MoMEngine] - 1M Candle Complete [${this.symbolToTrade}]: O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close}`);

        const breakoutSignal = this.breakoutExpert.analyze(candle);
        const pullbackSignal = this.pullbackExpert.analyze(candle);

        if (breakoutSignal === 'BUY' || pullbackSignal === 'BUY') {
            const orderId = this.executionEngine.placeLimitOrder(this.symbolToTrade, candle.close, 'BUY', 1);
            this.broker.executeMarketOrder(this.symbolToTrade, 1, 'BUY');
        } else if (breakoutSignal === 'SELL' || pullbackSignal === 'SELL') {
            const orderId = this.executionEngine.placeLimitOrder(this.symbolToTrade, candle.close, 'SELL', 1);
            this.broker.executeMarketOrder(this.symbolToTrade, 1, 'SELL');
        }
    }
}
