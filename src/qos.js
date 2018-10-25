function qosStatsObject() {
    return {
        localAddr: '',
        remoteAddr: '',
        callID: '',
        localID: '',
        remoteID: '',
        origID: '',
        fromTag:'',
        toTag:'',
        timestamp: {
            start: '',
            stop: ''
        },
        jitterArr: [],
        packetLost :0,
        packetsReceived: 0,
        jitterBufferNominal: 0,
        jitterBufferMax: 0,
        networkPacketLossRate: 0,
        jitterBufferDiscardRate: 0,
        NLR : 0,
        JBM : 0 ,
        JBN :  0,
        JDR : 0,
        MOSLQ: 0
    }
}

function getQosStats(session , options){
    this.session =  session;
    this.peer =  session.sessionDescriptionHandler.peerConnection;

    console.error(this.session.request);

    this.qosStatsObject= qosStatsObject();
    this.qosStatsObject.callID = this.session.request.call_id||'';
    this.qosStatsObject.fromTag  = this.session.from_tag || '';
    this.qosStatsObject.toTag  = this.session.to_tag || '';
    this.qosStatsObject.localID = this.session.request.headers.From[0].raw||this.session.request.headers.From[0];
    this.qosStatsObject.remoteID = this.session.request.headers.To[0].raw||this.session.request.headers.To[0];
    this.qosStatsObject.origID = this.session.request.headers.From[0].raw||this.session.request.headers.From[0];

    this.options = options || {};
    this.qResult = {};
    getStat(peer);
}


function average(array) {
    const sum = array.reduce((a, b) => a + b, 0);
    var avg = (sum / array.length);
    console.error("AVERGAE IS ",avg);
    return avg;
}

var peer = null;

function getStat(peer){
    var repeatInterval = 3000;
    getStats(peer, function (getStatsResult){
        this.qResult = getStatsResult;
        this.qosStatsObject.localAddr = qResult.connectionType.local.ipAddress[0];
        this.qosStatsObject.remoteAddr = qResult.connectionType.remote.ipAddress[0];
        this.qResult.results.forEach(function (item) {
            if (item.type === 'ssrc' && item.transportId === 'Channel-audio-1' && item.id.includes('recv')) {
                console.error(item);
                this.qosStatsObject.jitterBufferDiscardRate = item.googSecondaryDiscardedRate||0;
                this.qosStatsObject.packetLost = item.packetsLost;
                this.qosStatsObject.packetsReceived = item.packetsReceived;
                this.qosStatsObject.jitterArr.push(parseFloat(item.googJitterBufferMs));
            }
        });
    }, repeatInterval);
}


function calculateStats(){
    //NLR
    this.qosStatsObject.NLR =  (qosStatsObject.packetLost* 100 / (qosStatsObject.packetsReceived+qosStatsObject.packetLost)).toFixed(2)||0;

    //JitterBufferNominal
    this.qosStatsObject.JBN = average(qosStatsObject.jitterArr)||0;

    //JitterBufferMax
    this.qosStatsObject.JBM =  Math.max.apply(Math,qosStatsObject.jitterArr).toFixed(2)||0;

    //MOS Score
    this.qosStatsObject.MOSLQ = 0;

}


function resetStats(){
    this.qResult.nomore();
    this.qosStatsObject = qosStats();
}

function createPublishBody(){

    this.qResult.nomore();
    calculateStats();

    console.error('QOS STAT', this.qosStatsObject);

    var NLR =  this.qosStatsObject.NLR;
    var JBM = this.qosStatsObject.JBM;
    var JBN =  this.qosStatsObject.JBN;
    var JDR = this.qosStatsObject.JDR;
    var MOSLQ = this.qosStatsObject.MOSLQ;

    var callID = this.qosStatsObject.callID;
    var fromTag  = this.qosStatsObject.fromTag;
    var toTag  = this.qosStatsObject.toTag;;
    var localId = this.qosStatsObject.localID;
    var remoteId = this.qosStatsObject.remoteID;


    var xrBody = 'VQSessionReport: CallTerm\r\n' +
        'CallID: ' + callID + '\r\n' +
        'LocalID: ' + localId + '\r\n' +
        'RemoteID: ' + remoteId + '\r\n' +
        'OrigID: ' + localId + '\r\n' +
        'LocalAddr: IP='+this.qosStatsObject.localAddr+' SSRC=0x00000000\r\n' +
        'RemoteAddr: IP='+this.qosStatsObject.remoteAddr+' SSRC=0x00000000\r\n' +
        'LocalMetrics:\r\n' +
        'Timestamps: START=2017-01-05T00:45:38Z STOP=2017-01-05T00:45:52Z\r\n' +
        'SessionDesc: PT=0 PD=opus SR=0 FD=0 FPP=0 PPS=0 PLC=0 SSUP=on\r\n' +
        'JitterBuffer: JBA=0 JBR=0 JBN='+JBN+' JBM='+JBM+' JBX=0\r\n' +
        'PacketLoss: NLR='+NLR+' JDR='+JDR+'\r\n' +
        'BurstGapLoss: BLD=0 BD=0 GLD=0 GD=0 GMIN=0\r\n' +
        'Delay: RTD=0 ESD=0 SOWD=0 IAJ=0\r\n' +
        'QualityEst: MOSLQ='+MOSLQ+' MOSCQ=0.0\r\n' +
        'DialogID: ' + callID + ';to-tag=' + (toTag || '') + ';from-tag=' + (fromTag || '');


    console.error('xrBODY : ' , xrBody );

    return xrBody;
}


