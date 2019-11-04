import {WebPhoneSession} from './session';

const formatFloat = (input: any): string => parseFloat(input.toString()).toFixed(2);

export const startQosStatsCollection = (session: WebPhoneSession): void => {
    let qosStatsObj = getQoSStatsTemplate();

    qosStatsObj.callID = session.request.callId || '';
    qosStatsObj.fromTag = session.request.fromTag || '';
    qosStatsObj.toTag = session.request.toTag || '';
    qosStatsObj.localID = session.request.headers.From[0].raw || session.request.headers.From[0];
    qosStatsObj.remoteID = session.request.headers.To[0].raw || session.request.headers.To[0];
    qosStatsObj.origID = session.request.headers.From[0].raw || session.request.headers.From[0];

    let previousGetStatsResult;
    let qosCollection;

    qosCollection = setInterval(function() {
        session.sessionDescriptionHandler.peerConnection.getStats().then(function(report) {
            previousGetStatsResult = report;
            qosStatsObj.status = true;
            qosStatsObj.totalIntervalCount += 1;
            previousGetStatsResult.forEach(stat => {
                if (stat.type === 'inbound-rtp') {
                    qosStatsObj.packetLost = stat.packetsLost;
                    qosStatsObj.packetsReceived = stat.packetsReceived;
                    qosStatsObj.totalSumJitter += parseFloat(stat.jitter);
                    qosStatsObj.JBM = Math.max(qosStatsObj.JBM, parseFloat(stat.jitter));
                    console.error('Packets Lost = ' + stat.packetsLost);
                    console.error('Packets Recieved = ' + stat.packetsReceived);
                    console.error('Jitter  = ' + stat.jitter);
                }
                if (stat.type === 'local-candidate' && stat.candidateType === 'srflx') {
                    var network = getNetworkType(stat.networkType);
                    qosStatsObj.netType = addToMap(qosStatsObj.netType, network);
                    console.error('LOCAL CANDIDATE STAT');
                    console.error(stat);
                    console.error(network);
                }
            });
        });
        console.error('Counter ' + qosStatsObj.totalIntervalCount);
    }, session.ua.qosCollectInterval);

    session.on('terminated', function() {
        clearInterval(qosCollection);
        publishQosStats(session, qosStatsObj);
        console.error(qosStatsObj);
    });
};

const publishQosStats = (session: WebPhoneSession, qosStatsObj: QosStats, options: any = {}): void => {
    options = options || {};

    const effectiveType = navigator['connection'].effectiveType || '';
    const networkType = calculateNetworkUsage(qosStatsObj) || '';
    const targetUrl = options.targetUrl || 'rtcpxr@rtcpxr.ringcentral.com:5060';
    const event = options.event || 'vq-rtcpxr';
    options.expires = 60;
    options.contentType = 'application/vq-rtcpxr';
    options.extraHeaders = options.extraHeaders || [];
    options.extraHeaders.push(
        'p-rc-client-info:' + 'cpuRC=0:0;cpuOS=0:0;netType=' + networkType + ';ram=0:0;effectiveType=' + effectiveType
    );

    const calculatedStatsObj = calculateStats(qosStatsObj);
    const body = createPublishBody(calculatedStatsObj);
    const pub = session.ua.publish(targetUrl, event, body, options);
    session.logger.log('Local Candidate: ' + JSON.stringify(qosStatsObj.localcandidate));
    session.logger.log('Remote Candidate: ' + JSON.stringify(qosStatsObj.remotecandidate));

    qosStatsObj.status = false;
    pub.close();
    session.emit('qos-published', body);
};

const calculateNetworkUsage = (qosStatsObj: QosStats): string => {
    const networkType = [];
    for (const [key, value] of Object.entries(qosStatsObj.netType)) {
        networkType.push(key + ':' + formatFloat(((value as any) * 100) / qosStatsObj.totalIntervalCount));
    }
    return networkType.join();
};

const calculateStats = (qosStatsObj: QosStats): QosStats => {
    const rawNLR = (qosStatsObj.packetLost * 100) / (qosStatsObj.packetsReceived + qosStatsObj.packetLost) || 0;
    const rawJBN = qosStatsObj.totalIntervalCount > 0 ? qosStatsObj.totalSumJitter / qosStatsObj.totalIntervalCount : 0;

    return {
        ...qosStatsObj,
        NLR: formatFloat(rawNLR),
        JBN: formatFloat(rawJBN), //JitterBufferNominal
        JDR: formatFloat(qosStatsObj.jitterBufferDiscardRate), //JitterBufferDiscardRate
        MOSLQ: 0 //MOS Score
    };
};

const createPublishBody = (calculatedStatsObj: QosStats): string => {
    const NLR = calculatedStatsObj.NLR || 0;
    const JBM = calculatedStatsObj.JBM || 0;
    const JBN = calculatedStatsObj.JBN || 0;
    const JDR = calculatedStatsObj.JDR || 0;
    const MOSLQ = calculatedStatsObj.MOSLQ || 0;

    const callID = calculatedStatsObj.callID || '';
    const fromTag = calculatedStatsObj.fromTag || '';
    const toTag = calculatedStatsObj.toTag || '';
    const localId = calculatedStatsObj.localID || '';
    const remoteId = calculatedStatsObj.remoteID || '';

    const localAddr = calculatedStatsObj.localAddr || '';
    const remoteAddr = calculatedStatsObj.remoteAddr || '';

    return (
        `VQSessionReport: CallTerm\r\n` +
        `CallID: ${callID}\r\n` +
        `LocalID: ${localId}\r\n` +
        `RemoteID: ${remoteId}\r\n` +
        `OrigID: ${localId}\r\n` +
        `LocalAddr: IP=${localAddr} SSRC=0x00000000\r\n` +
        `RemoteAddr: IP=${remoteAddr} SSRC=0x00000000\r\n` +
        `LocalMetrics:\r\n` +
        `Timestamps: START=0 STOP=0\r\n` +
        `SessionDesc: PT=0 PD=opus SR=0 FD=0 FPP=0 PPS=0 PLC=0 SSUP=on\r\n` +
        `JitterBuffer: JBA=0 JBR=0 JBN=${JBN} JBM=${JBM} JBX=0\r\n` +
        `PacketLoss: NLR=${NLR} JDR=${JDR}\r\n` +
        `BurstGapLoss: BLD=0 BD=0 GLD=0 GD=0 GMIN=0\r\n` +
        `Delay: RTD=0 ESD=0 SOWD=0 IAJ=0\r\n` +
        `QualityEst: MOSLQ=${MOSLQ} MOSCQ=0.0\r\n` +
        `DialogID: ${callID};to-tag=${toTag};from-tag=${fromTag}`
    );
};

const getQoSStatsTemplate = (): QosStats => ({
    localAddr: '',
    remoteAddr: '',
    callID: '',
    localID: '',
    remoteID: '',
    origID: '',
    fromTag: '',
    toTag: '',
    timestamp: {
        start: '',
        stop: ''
    },

    netType: {},

    packetLost: 0,
    packetsReceived: 0,

    jitterBufferNominal: 0,
    jitterBufferMax: 0,

    jitterBufferDiscardRate: 0,

    totalSumJitter: 0,
    totalIntervalCount: 0,

    NLR: '',
    JBM: 0,
    JBN: '',
    JDR: '',
    MOSLQ: 0,

    status: false,
    localcandidate: {},
    remotecandidate: {}
});

const addToMap = (map: any = {}, key: string): any => ({
    ...map,
    [key]: (key in map ? parseInt(map[key]) : 0) + 1
});

enum networkTypeMap {
    bluetooth = 'Bluetooth',
    cellular = 'Cellulars',
    ethernet = 'Ethernet',
    wifi = 'WiFi',
    wimax = 'WiMax',
    vpn = 'VPN',
    '2g' = '2G',
    '3g' = '3G',
    '4g' = '4G'
}

//TODO: find relaible way to find network type , use navigator.connection.type?
const getNetworkType = (connectionType): networkTypeMap => {
    const networkType = connectionType || 'unknown';
    return networkType in networkTypeMap ? networkTypeMap[networkType] : networkType;
};

export interface QosStats {
    localAddr: string;
    remoteAddr: string;
    callID: string;
    localID: string;
    remoteID: string;
    origID: string;
    fromTag: string;
    toTag: string;
    timestamp: {
        start: string;
        stop: string;
    };

    netType: any;

    packetLost: number;
    packetsReceived: number;

    jitterBufferNominal: number;
    jitterBufferMax: number;

    jitterBufferDiscardRate: number;

    totalSumJitter: number;
    totalIntervalCount: number;

    NLR: string;
    JBM: number;
    JBN: string;
    JDR: string;
    MOSLQ: number;

    status: boolean;

    localcandidate: any;
    remotecandidate: any;
}
