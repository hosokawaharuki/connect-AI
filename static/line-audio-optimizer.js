/**
 * イヤホン使用時を含め、タップ音や環境音を自動カットし、話者の声のみを厳選出力する高度オーディオオプティマイザー
 */
(function() {
    'use strict';

    if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        
        navigator.mediaDevices.getUserMedia = function(constraints) {
            if (constraints && constraints.audio) {
                const lineGradeAudioConstraints = {
                    echoCancellation: true,      
                    noiseSuppression: true,      
                    autoGainControl: true,       
                    voiceIsolation: true,        // 話者ボイスアイソレーション（声以外の環境音・タップ音をカット）
                    channelCount: 1,             
                    sampleRate: 48000,
                    googEchoCancellation: true,
                    googAutoGainControl: true,
                    googNoiseSuppression: true,
                    googHighpassFilter: true,    
                    googTypingNoiseDetection: true // タップ音・タイピング音検出抑制
                };

                if (typeof constraints.audio === 'object') {
                    constraints.audio = Object.assign({}, constraints.audio, lineGradeAudioConstraints);
                } else {
                    constraints.audio = lineGradeAudioConstraints;
                }
            }
            return originalGetUserMedia(constraints);
        };
    }
})();