class NoiseProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.noiseThreshold = 0.02; // 自動適応型の判定閾値
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || input.length === 0) return true;
        
        const channelData = input[0];
        const outputData = output[0];
        if (!channelData || !outputData) return true;

        let rms = 0;
        for (let i = 0; i < channelData.length; i++) {
            rms += channelData[i] * channelData[i];
        }
        rms = Math.sqrt(rms / channelData.length);

        // タップ音や微小な環境雑音を除外し、話者の声のみを通過させるAUTOゲート
        const isVoiceActive = rms > this.noiseThreshold;

        for (let i = 0; i < channelData.length; i++) {
            outputData[i] = isVoiceActive ? channelData[i] : 0;
        }

        return true;
    }
}

registerProcessor('noise-processor', NoiseProcessor);