(function(root, factory) {
    if (typeof define === 'function' && define.amd) {
        define(['sip.js', 'getstats'], function(SIP, getStats) {
            return factory(SIP, getStats || root.getStats);
        });
    } else if (typeof module === 'object') {
        module.exports = factory(require('sip.js'), require('getstats') || root.getStats);
        module.exports.default = module.exports; //ES6
    } else {
        root.RingCentral = root.RingCentral ||  {};
        root.RingCentral.WebPhone = factory(root.SIP, root.getStats);
    }
}(this, function(SIP, getStats) {

    var messages = {
        park: {reqid: 1, command: 'callpark'},
        startRecord: {reqid: 2, command: 'startcallrecord'},
        stopRecord: {reqid: 3, command: 'stopcallrecord'},
        flip: {reqid: 3, command: 'callflip', target: ''},
        monitor: {reqid: 4, command: 'monitor'},
        barge: {reqid: 5, command: 'barge'},
        whisper: {reqid: 6, command: 'whisper'},
        takeover: {reqid: 7, command: 'takeover'},
        toVoicemail: {reqid: 11, command: 'toVoicemail'},
        ignore: {reqid: 12, command: 'ignore'},
        receiveConfirm: {reqid: 17, command: 'receiveConfirm'},
        replyWithMessage: {reqid: 14, command: 'replyWithMessage'},
    };

    var uuidKey = 'rc-webPhone-uuid';

    var responseTimeout = 60000;

    var defaultMediaConstraints   =  {
        audio: true,
        video: false
    };


    function uuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    function delay(ms) {
        return new Promise(function(resolve, reject) {
            setTimeout(resolve, ms);
        });
    }

    function extend(dst, src) {
        src = src || {};
        dst = dst || {};
        Object.keys(src).forEach(function(k) {
            dst[k] = src[k];
        });
        return dst;
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @param options
     * @constructor
     */
    function AudioHelper(options) {

        options = options || {};

        this._enabled = !!options.enabled;
        this.loadAudio(options);
    }

    AudioHelper.prototype._playSound = function(url, val, volume) {

        if (!this._enabled || !url) return this;

        if (!this._audio[url]) {
            if (val) {
                this._audio[url] = new Audio();
                this._audio[url].src = url;
                this._audio[url].loop = true;
                this._audio[url].volume = volume;
                this._audio[url].playPromise = this._audio[url].play();
            }
        } else {
            if (val) {
                this._audio[url].currentTime = 0;
                this._audio[url].playPromise = this._audio[url].play();
            } else {
                var audio = this._audio[url];
                if (audio.playPromise !== undefined) {
                    audio.playPromise.then(function() {
                        audio.pause();
                    });
                }
            }
        }

        return this;

    };

    AudioHelper.prototype.loadAudio = function(options) {
        this._incoming = options.incoming;
        this._outgoing = options.outgoing;
        this._audio = {};
    };

    AudioHelper.prototype.setVolume = function(volume) {
        if (volume < 0) { volume = 0; }
        if (volume > 1) { volume = 1; }
        this.volume = volume;
        for (var url in this._audio) {
            if (this._audio.hasOwnProperty(url)) {
                this._audio[url].volume = volume;
            }
        }
    };

    AudioHelper.prototype.playIncoming = function(val) {
        return this._playSound(this._incoming, val, (this.volume || 0.5));
    };

    AudioHelper.prototype.playOutgoing = function(val) {
        return this._playSound(this._outgoing, val, (this.volume || 1));
    };

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @param {object} regData
     * @param {object} [options]
     * @param {string} [options.uuid]
     * @param {string} [options.appKey]
     * @param {string} [options.appName]
     * @param {string} [options.appVersion]
     * @param {string} [options.audioHelper]
     * @param {string} [options.onSession] fired each time UserAgent starts working with session
     * @constructor
     */

    //TODO: include 'WebPhone' for all apps other than Chrome and Glip
    function WebPhone(regData, options) {

        regData = regData || {};
        options = options || {};

        this.sipInfo = regData.sipInfo[0] || regData.sipInfo;
        this.sipFlags = regData.sipFlags;

        this.uuidKey = options.uuidKey || uuidKey;

        var id = options.uuid || localStorage.getItem(this.uuidKey) || uuid(); //TODO Make configurable
        localStorage.setItem(this.uuidKey, id);

        this.appKey = options.appKey;
        this.appName = options.appName;
        this.appVersion = options.appVersion;

        var ua_match = navigator.userAgent.match(/\((.*?)\)/);
        var app_client_os = (ua_match && ua_match.length && ua_match[1]).replace(/[^a-zA-Z0-9.:_]+/g,"-") || '';

        var userAgentString = (
            (options.appName ? (options.appName + (options.appVersion ? '/' + options.appVersion : '')) + ' ' : '') +
            (app_client_os ? app_client_os  : '') +
            ' RCWEBPHONE/' + WebPhone.version
        );

        var modifiers = options.modifiers || [];
        modifiers.push(SIP.Web.Modifiers.stripG722);
        modifiers.push(SIP.Web.Modifiers.stripTcpCandidates);
        //enable for unified sdp
        // modifiers.push(SIP.Web.Modifiers.addMidLines);

        var sessionDescriptionHandlerFactoryOptions = options.sessionDescriptionHandlerFactoryOptions || {
            peerConnectionOptions: {
                iceCheckingTimeout: this.sipInfo.iceCheckingTimeout || this.sipInfo.iceGatheringTimeout || 500,
                rtcConfiguration: {
                    rtcpMuxPolicy: 'negotiate',
                    //disable for unified sdp
                    sdpSemantics:'plan-b'
                }
            },
            constraints: options.mediaConstraints||defaultMediaConstraints,
            modifiers: modifiers
        };


        var browserUa = navigator.userAgent.toLowerCase();
        var isSafari = false;
        var isFirefox = false;

        if (browserUa.indexOf('safari') > -1 && browserUa.indexOf('chrome') < 0) {
            isSafari = true;
        } else if (browserUa.indexOf('firefox') > -1 && browserUa.indexOf('chrome') < 0) {
            isFirefox = true;
        }

        if (isFirefox) {
            sessionDescriptionHandlerFactoryOptions.alwaysAcquireMediaFirst = true;
        }

        var sessionDescriptionHandlerFactory =  options.sessionDescriptionHandlerFactory || [];

        var configuration = {
            uri: 'sip:' + this.sipInfo.username + '@' + this.sipInfo.domain,

            transportOptions: {
                wsServers: this.sipInfo.outboundProxy && this.sipInfo.transport
                    ? this.sipInfo.transport.toLowerCase() + '://' + this.sipInfo.outboundProxy
                    : this.sipInfo.wsServers,
                traceSip: true,
                maxReconnectionAttempts: options.maxReconnectionAttempts || 3,
                reconnectionTimeout: options.reconnectionTimeout || 5,
                connectionTimeout: options.connectionTimeout || 5
            },
            authorizationUser: this.sipInfo.authorizationId,
            password: this.sipInfo.password,
            stunServers: this.sipInfo.stunServers || ['stun:74.125.194.127:19302'], //FIXME Hardcoded?
            turnServers: [],
            log: {
                level: options.logLevel || 1 ,//FIXME LOG LEVEL 3
                builtinEnabled : options.builtinEnabled || true,
                connector  : options.connector|| null
            },
            domain: this.sipInfo.domain,
            autostart: false,
            register: false,
            userAgentString: userAgentString,
            sessionDescriptionHandlerFactoryOptions: sessionDescriptionHandlerFactoryOptions,
            sessionDescriptionHandlerFactory : sessionDescriptionHandlerFactory
        };
        this.userAgent = new SIP.UA(configuration);

        this.userAgent.defaultHeaders = [
            'P-rc-endpoint-id: ' + id,
            'Client-id:' + options.appKey
        ];

        this.userAgent.media = {};

        this.userAgent.qosCollectInterval = options.qosCollectInterval || 5000;

        if (options.media && (options.media.remote && options.media.local)){
            this.userAgent.media.remote = options.media.remote ;
            this.userAgent.media.local = options.media.local;
        }
        else
            this.userAgent.media = null;

        this.userAgent.sipInfo = this.sipInfo;

        this.userAgent.__invite = this.userAgent.invite;
        this.userAgent.invite = invite;

        this.userAgent.__register = this.userAgent.register;
        this.userAgent.register = register;

        this.userAgent.__unregister = this.userAgent.unregister;
        this.userAgent.unregister = unregister;

        this.userAgent.on('invite', function(session) {
            this.userAgent.audioHelper.playIncoming(true);
            patchSession(session);
            patchIncomingSession(session);
            session._sendReceiveConfirmPromise = session.sendReceiveConfirm().then(function() {
                session.logger.log('sendReceiveConfirm success');
            }).catch(function(error){
                session.logger.error('failed to send receive confirmation via SIP MESSAGE due to ' + error);
                throw error;
            });
        }.bind(this));

        this.userAgent.audioHelper = new AudioHelper(options.audioHelper);

        this.userAgent.onSession = options.onSession || null;
        this.userAgent.createRcMessage = createRcMessage;
        this.userAgent.sendMessage = sendMessage;
        this.userAgent._onMessage = this.userAgent.onTransportReceiveMsg;
        this.userAgent.onTransportReceiveMsg = onMessage.bind(this.userAgent);
        this.userAgent.start();
        this.userAgent.register();
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    WebPhone.version = '0.6.2';
    WebPhone.uuid = uuid;
    WebPhone.delay = delay;
    WebPhone.extend = extend;

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @param {object} options
     * @return {String}
     */
    function createRcMessage(options) {
        options.body = options.body || '';
        var msgBody = '<Msg><Hdr SID="' + options.sid + '" Req="' + options.request + '" From="' + options.from + '" To="' + options.to +'" Cmd="' + options.reqid + '"/> <Bdy Cln="' + this.sipInfo.authorizationId + '" ' + options.body + '/></Msg>';
        return msgBody;
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.UserAgent}
     * @param {object} options
     * @return {Promise}
     */
    function sendMessage(to, messageData) {
        var userAgent = this;
        var sipOptions = {};
        sipOptions.contentType = 'x-rc/agent';
        sipOptions.extraHeaders = [];
        sipOptions.extraHeaders.push('P-rc-ws: ' + this.contact);

        return new Promise(function(resolve, reject) {
            var message = userAgent.message(to, messageData, sipOptions);

            message.once('accepted', function(response, cause) {
                resolve();
            });
            message.once('failed', function(response, cause) {
                reject(new Error(cause));
            });
        });
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    function onMessage(e) {
        // This is a temporary solution to avoid timeout errors for MESSAGE responses.
        // Timeout is caused by port specification in host field within Via header.
        // sip.js requires received viaHost in a response to be the same as ours via host therefore
        // messages with the same host but with port are ignored.
        // This is the exact case for WSX: it send host:port inn via header in MESSAGE responses.
        // To overcome this, we will preprocess MESSAGE messages and remove port from viaHost field.
        var data = e.data;

        // WebSocket binary message.
        if (typeof data !== 'string') {
            try {
                data = String.fromCharCode.apply(null, new Uint8Array(data));
            }
            catch(error) {
                return this._onMessage.apply(this, [e]);
            }
        }

        if (data.match(/CSeq:\s*\d+\s+MESSAGE/i)) {
            var re = new RegExp(this.ua.configuration.viaHost + ':\\d+',"g");
            var newData = e.data.replace(re, this.ua.configuration.viaHost);
            Object.defineProperty(e, "data", {
                value: newData,
                writable: false
            });
        }

        return this._onMessage.apply(this, [e]);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/




    function patchSession(session) {

        if (session.__patched) return session;

        session.__patched = true;

        session.__sendRequest = session.sendRequest;
        session.__receiveRequest = session.receiveRequest;
        session.__accept = session.accept;
        session.__hold = session.hold;
        session.__unhold = session.unhold;
        session.__dtmf = session.dtmf;
        session.__reinvite=session.reinvite;

        session.sendRequest = sendRequest;
        session.receiveRequest = receiveRequest;
        session.accept = accept;
        session.hold = hold;
        session.unhold = unhold;
        session.dtmf = dtmf;
        session.reinvite=reinvite;

        session.warmTransfer = warmTransfer;
        session.blindTransfer = blindTransfer;
        session.transfer = transfer;
        session.park = park;
        session.forward = forward;
        session.startRecord = startRecord;
        session.stopRecord = stopRecord;
        session.flip = flip;

        session.mute = mute;
        session.unmute = unmute;
        session.onLocalHold = onLocalHold;

        session.media = session.ua.media;
        session.addTrack = addTrack;


        //------------------QOS---------------------------------//

        session.publishQosStats = publishQosStats;
        session.qosStatsObj = getQoSStatsTemplate();
        session.startQosStatsCollection = startQosStatsCollection;
        session.netTypeObj = {};

        //------------------QOS---------------------------------//

        session.on('replaced', patchSession);

        // Audio
        session.on('progress', function(incomingResponse) {
            stopPlaying();
            if (incomingResponse.status_code === 183) {
                session.createDialog(incomingResponse, 'UAC');
                session.hasAnswer = true;
                session.status = 11;
                session.emit('active-call');
                session.sessionDescriptionHandler.setDescription(incomingResponse.body)
                    .catch(function (exception) {
                        session.logger.warn(exception);
                        session.failed(incomingResponse, C.causes.BAD_MEDIA_DESCRIPTION);
                        session.terminate({status_code: 488, reason_phrase: 'Bad Media Description'})
                    });
            }});

        if(session.media)
            session.on('trackAdded',addTrack);

        session.on('accepted', stopPlaying);
        session.on('rejected', stopPlaying);
        session.on('bye', stopPlaying);
        session.on('terminated', stopPlaying);
        session.on('cancel', stopPlaying);
        session.on('failed', stopPlaying);
        session.on('replaced', stopPlaying);


        function stopPlaying() {
            session.ua.audioHelper.playOutgoing(false);
            session.ua.audioHelper.playIncoming(false);
            session.removeListener('accepted', stopPlaying);
            session.removeListener('rejected', stopPlaying);
            session.removeListener('bye', stopPlaying);
            session.removeListener('terminated', stopPlaying);
            session.removeListener('cancel', stopPlaying);
            session.removeListener('failed', stopPlaying);
            session.removeListener('replaced', stopPlaying);
        }

        if (session.ua.onSession) session.ua.onSession(session);

        return session;

    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    function patchIncomingSession(session) {
        try {
            parseRcHeader(session);
        } catch (e) {
            session.logger.error('Can\'t parse RC headers from invite request due to ' + e);
        }
        session.canUseRCMCallControl = canUseRCMCallControl;
        session.createSessionMessage = createSessionMessage;
        session.sendSessionMessage = sendSessionMessage;
        session.sendReceiveConfirm = sendReceiveConfirm;
        session.ignore = ignore;
        session.toVoicemail = toVoicemail;
        session.replyWithMessage = replyWithMessage;
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    function parseRcHeader(session) {
        var prc = session.request.headers['P-Rc'];
        if (prc && prc.length) {
            var rawInviteMsg = prc[0].raw;
            var parser = new DOMParser();
            var xmlDoc = parser.parseFromString(rawInviteMsg, 'text/xml');
            var hdrNode = xmlDoc.getElementsByTagName('Hdr')[0];
            var bdyNode = xmlDoc.getElementsByTagName('Bdy')[0];

            if (hdrNode) {
                session.rcHeaders = {
                    sid: hdrNode.getAttribute('SID'),
                    request: hdrNode.getAttribute('Req'),
                    from: hdrNode.getAttribute('From'),
                    to: hdrNode.getAttribute('To'),
                };
            }
            if (bdyNode) {
                extend(session.rcHeaders, {
                    srvLvl: bdyNode.getAttribute('SrvLvl'),
                    srvLvlExt: bdyNode.getAttribute('SrvLvlExt'),
                    toNm: bdyNode.getAttribute('ToNm'),
                });
            }
        }
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @return {Bool}
     */
    function canUseRCMCallControl() {
        return !!this.rcHeaders;
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @param {object} options
     * @return {String}
     */
    function createSessionMessage(options) {
        if (!this.rcHeaders) {
            return undefined;
        }
        extend(options, {
            sid: this.rcHeaders.sid,
            request: this.rcHeaders.request,
            from: this.rcHeaders.to,
            to: this.rcHeaders.from,
        });
        return this.ua.createRcMessage(options);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @return {Promise}
     */
    function ignore() {
        var session = this;        
        return session._sendReceiveConfirmPromise.then(function () {
            return session.sendSessionMessage(messages.ignore);
        });
    }
    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @param {object} options
     * @return {Promise}
     */
    function sendSessionMessage(options) {
        if (!this.rcHeaders) {
            return Promise.reject(new Error('Can\'t send SIP MESSAGE related to session: no RC headers available'));
        }

        var to = this.rcHeaders.from;

        return this.ua.sendMessage(to, this.createSessionMessage(options));
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @return {Promise}
     */
    function sendReceiveConfirm() {
        return this.sendSessionMessage(messages.receiveConfirm);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @return {Promise}
     */
    function toVoicemail() {
        var session = this;
        return session._sendReceiveConfirmPromise.then(function () {
            return session.sendSessionMessage(messages.toVoicemail);
        });
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @param {object} replyOptions
     * @return {Promise}
     */
    function replyWithMessage(replyOptions) {
        var body = 'RepTp="'+ replyOptions.replyType +'"';

        if (replyOptions.replyType === 0) {
            body += ' Bdy="'+ replyOptions.replyText +'"';
        } else if (replyOptions.replyType === 1){
            body += ' Vl="'+ replyOptions.timeValue +'"';
            body += ' Units="'+ replyOptions.timeUnits +'"';
            body += ' Dir="'+ replyOptions.callbackDirection +'"';
        }
        var session = this;
        return session._sendReceiveConfirmPromise.then(function () {
            return session.sendSessionMessage({ reqid: messages.replyWithMessage.reqid, body: body });
        });
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @private
     * @param {SIP.Session} session
     * @param {object} command
     * @param {object} [options]
     * @return {Promise}
     */
    function sendReceive(session, command, options) {
        options = options || {};

        extend(command, options);

        var cseq = null;

        return new Promise(function(resolve, reject) {

            var extraHeaders = (options.extraHeaders || []).concat(session.ua.defaultHeaders).concat([
                'Content-Type: application/json;charset=utf-8'
            ]);

            session.sendRequest(SIP.C.INFO, {
                body: JSON.stringify({
                    request: command
                }),
                extraHeaders: extraHeaders,
                receiveResponse: function(response) {
                    var timeout = null;
                    if (response.status_code === 200) {
                        cseq = response.cseq;
                        var onInfo = function(request) {
                            if (response.cseq === cseq) {

                                var body = request && request.body || '{}';
                                var obj;

                                try {
                                    obj = JSON.parse(body);
                                } catch (e) {
                                    obj = {};
                                }

                                if (obj.response && obj.response.command === command.command) {
                                    if (obj.response.result) {
                                        if (obj.response.result.code == 0) {
                                            return resolve(obj.response.result);
                                        } else {
                                            return reject(obj.response.result);
                                        }
                                    }
                                }
                                timeout && clearTimeout(timeout);
                                session.removeListener('RC_SIP_INFO', onInfo);
                                resolve(null); //FIXME What to resolve
                            }
                        };

                        timeout = setTimeout(function() {
                            reject(new Error('Timeout: no reply'));
                            session.removeListener('RC_SIP_INFO', onInfo);
                        }, responseTimeout);
                        session.on('RC_SIP_INFO', onInfo);
                    }
                    else {
                        reject(new Error('The INFO response status code is: ' + response.status_code + ' (waiting for 200)'));
                    }
                }
            });

        });

    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    function register(options) {
        options = options || {};
        options.extraHeaders = (options.extraHeaders || []).concat(this.defaultHeaders);
        return this.__register.call(this, options);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    function unregister(options) {
        options = options || {};
        options.extraHeaders = (options.extraHeaders || []).concat(this.defaultHeaders);
        return this.__unregister.call(this, options);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    function sendRequest(type, config) {
        if (type == SIP.C.PRACK) {
            // type = SIP.C.ACK;
            return this;
        }
        return this.__sendRequest(type, config);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @private
     * @param {SIP.Session} session
     * @param {boolean} flag
     * @return {Promise}
     */
    function setRecord(session, flag) {

        var message = !!flag
            ? messages.startRecord
            : messages.stopRecord;

        if ((session.__onRecord && !flag) || (!session.__onRecord && flag)) {
            return sendReceive(session, message)
                .then(function(data) {
                    session.__onRecord = !!flag;
                    return data;
                });
        }

    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @private
     * @param {SIP.Session} session
     * @param {boolean} flag
     * @return {Promise}
     */
    function setLocalHold(session, flag) {
        return new Promise(function(resolve, reject) {

            var options = {
                eventHandlers: {
                    succeeded: resolve,
                    failed: reject
                }
            };

            if (flag) {
                resolve(session.__hold(options));
            } else {
                resolve(session.__unhold(options));
            }

        });
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.UA}
     * @param number
     * @param options
     * @return {SIP.Session}
     */
    function invite(number, options) {

        var ua = this;

        options = options || {};
        options.extraHeaders = (options.extraHeaders || []).concat(ua.defaultHeaders);

        options.extraHeaders.push('P-Asserted-Identity: sip:' + (options.fromNumber || ua.sipInfo.username) + '@' + ua.sipInfo.domain); //FIXME Phone Number

        //FIXME Backend should know it already
        if (options.homeCountryId) { options.extraHeaders.push('P-rc-country-id: ' + options.homeCountryId); }

        options.RTCConstraints = options.RTCConstraints || {optional: [{DtlsSrtpKeyAgreement: 'true'}]};

        ua.audioHelper.playOutgoing(true);
        return patchSession(ua.__invite(number, options));

    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @param request
     * @return {*}
     */
    function receiveRequest(request) {
        var session = this;
        switch (request.method) {
            case SIP.C.INFO:
                session.emit('RC_SIP_INFO', request);
                //SIP.js does not support application/json content type, so we monkey override its behaviour in this case
                if (session.status === SIP.Session.C.STATUS_CONFIRMED || session.status === SIP.Session.C.STATUS_WAITING_FOR_ACK) {
                    var contentType = request.getHeader('content-type');
                    if (contentType.match(/^application\/json/i)) {
                        request.reply(200);
                        return session;
                    }
                }
                break;
        }
        return session.__receiveRequest.apply(session, arguments);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @param {object} options
     * @return {Promise}
     */
    function accept(options) {

        var session = this;

        options = options || {};
        options.extraHeaders = (options.extraHeaders || []).concat(session.ua.defaultHeaders);
        options.RTCConstraints = options.RTCConstraints || {optional: [{DtlsSrtpKeyAgreement: 'true'}]};

        return new Promise(function(resolve, reject) {

            function onAnswered() {
                session.emit('active-call');
                resolve(session);
                session.removeListener('failed', onFail);
            }

            function onFail(e) {
                reject(e);
                session.removeListener('accepted', onAnswered);
            }

            //TODO More events?
            session.once('accepted', onAnswered);
            session.once('failed', onFail);
            session.__accept(options);
        });


    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session} session
     * @param {string} dtmf
     * @param {number} duration
     * @return {Promise}
     */
    function dtmf(dtmf, duration) {
        var session = this;
        duration = parseInt(duration) || 1000;
        var pc = session.sessionDescriptionHandler.peerConnection;
        var senders = pc.getSenders();
        var audioSender = senders.find(function(sender) {
            return sender.track && sender.track.kind === 'audio';
        });
        var dtmfSender = audioSender.dtmf;
        if (dtmfSender !== undefined && dtmfSender) {
            return dtmfSender.insertDTMF(dtmf, duration);
        }
        throw new Error('Send DTMF failed: ' + (!dtmfSender ? 'no sender' : (!dtmfSender.canInsertDTMF ? 'can\'t insert DTMF' : 'Unknown')));
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session} session
     * @return {Promise}
     */
    function hold() {
        return setLocalHold(this, true);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session} session
     * @return {Promise}
     */
    function unhold() {
        return setLocalHold(this, false);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session} session
     * @param {string} target
     * @param {object} options
     * @return {Promise}
     */
    function blindTransfer(target, options) {

        options = options || {};

        var session = this;
        var extraHeaders = options.extraHeaders || [];
        var originalTarget = target;

        return new Promise(function(resolve, reject) {
            //Blind Transfer is taken from SIP.js source
            return session.refer(target, options);
        });
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session} session
     * @param {SIP.Session} target
     * @param {object} transferOptions
     * @return {Promise}
     */
    function warmTransfer(target, transferOptions) {

        var session = this;

        return (session.local_hold ? Promise.resolve(null) : session.hold())
            .then(function() { return delay(300); })
            .then(function() {

                var referTo = '<' + target.dialog.remote_target.toString() +
                    '?Replaces=' + target.dialog.id.call_id +
                    '%3Bto-tag%3D' + target.dialog.id.remote_tag +
                    '%3Bfrom-tag%3D' + target.dialog.id.local_tag + '>';

                transferOptions = transferOptions || {};
                transferOptions.extraHeaders = (transferOptions.extraHeaders || [])
                    .concat(session.ua.defaultHeaders)
                    .concat(['Referred-By: ' + session.dialog.remote_target.toString()]);

                //TODO return session.refer(newSession);
                return session.blindTransfer(referTo, transferOptions);

            });

    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @param {string} target
     * @param {object} options
     * @return {Promise}
     */
    function transfer(target, options) {

        var session = this;

        return (session.local_hold ? Promise.resolve(null) : session.hold())
            .then(function() { return delay(300); })
            .then(function() {
                return session.blindTransfer(target, options);
            });

    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @param {string} target
     * @param {object} acceptOptions
     * @param {object} [transferOptions]
     * @return {Promise}
     */
    function forward(target, acceptOptions, transferOptions) {

        var interval = null,
            session = this;

        return session.accept(acceptOptions)
            .then(function() {

                return new Promise(function(resolve, reject) {
                    interval = setInterval(function() {
                        if (session.status === 12) {
                            clearInterval(interval);
                            session.mute();
                            setTimeout(function() {
                                resolve(session.transfer(target, transferOptions));
                            }, 700);
                        }
                    }, 50);
                });

            });

    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @return {Promise}
     */
    function startRecord() {
        return setRecord(this, true);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @return {Promise}
     */
    function stopRecord() {
        return setRecord(this, false);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @param target
     * @return {Promise}
     */
    function flip(target) {
        return sendReceive(this, messages.flip, {target: target});
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @return {Promise}
     */
    function park() {
        return sendReceive(this, messages.park);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/
    /**
     * @this {SIP.Session}
     * @return {Promise}
     */

    function reinvite (options, modifier){
        var session = this;
        options = options || {}
        options.sessionDescriptionHandlerOptions = options.sessionDescriptionHandlerOptions || {};
        return session.__reinvite(options, modifier);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/


    function toggleMute (session , mute) {
        var pc = session.sessionDescriptionHandler.peerConnection;
        if (pc.getSenders) {
            pc.getSenders().forEach(function(sender) {
                if (sender.track) {
                    sender.track.enabled = !mute;
                }
            });
        }
    };

    /*--------------------------------------------------------------------------------------------------------------------*/
    function mute (silent){
        if (this.state !== this.STATUS_CONNECTED) {
            this.logger.warn('An acitve call is required to mute audio');
            return;
        }
        this.logger.log('Muting Audio');
        if (!silent) {
            this.emit('muted',this.session);
        }
        return toggleMute(this, true);
    };

    /*--------------------------------------------------------------------------------------------------------------------*/

    function unmute(silent) {
        if (this.state !== this.STATUS_CONNECTED) {
            this.logger.warn('An active call is required to unmute audio');
            return;
        }
        this.logger.log('Unmuting Audio');
        if (!silent) {
            this.emit('unmuted',this.session);
        }
        return toggleMute(this,false);
    };

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     * @return boolean
     */

    function onLocalHold (){
        var session = this;
        return session.local_hold;
    };

    /*--------------------------------------------------------------------------------------------------------------------*/


    function addTrack(remoteAudioEle, localAudioEle){

        var session = this;
        var pc = session.sessionDescriptionHandler.peerConnection;

        var remoteAudio;
        var localAudio;

        if(remoteAudioEle&&localAudioEle){
            remoteAudio = remoteAudioEle;
            localAudio = localAudioEle;
        }
        else if(session.media){
            remoteAudio = session.media.remote;
            localAudio = session.media.local;
        }
        else
            throw new Error('HTML Media Element not Defined');


        var remoteStream = new MediaStream();
        if(pc.getReceivers){
            pc.getReceivers().forEach(function(receiver) {
                var rtrack = receiver.track;
                if(rtrack){
                    remoteStream.addTrack(rtrack);
                }});
        }
        else{
            remoteStream = pc.getRemoteStreams()[0];
        }
        remoteAudio.srcObject = remoteStream;
        remoteAudio.play().catch(function() {
            session.logger.log('local play was rejected');
        });

        var localStream = new MediaStream();
        if(pc.getSenders){
            pc.getSenders().forEach(function(sender) {
                var strack = sender.track;
                if (strack && strack.kind === 'audio') {
                    localStream.addTrack(strack);
                }
            });
        }
        else{
            localStream = pc.getLocalStreams()[0];
        }
        localAudio.srcObject = localStream;
        localAudio.play().catch(function() {
            session.logger.log('local play was rejected');
        });

    }

    /*--------------------------------------------------------------------------------------------------------------------*/
    //------------------QOS---------------------------------//


    /**
     * @this {SIP.Session}
     */
    function publishQosStats(options){
        var session = this;

        if(session.qosStatsObj.status) {
            session.getStatsResult && session.getStatsResult.nomore();
            var networkType = calculateNetworkUsage(session) || '';
            options = options || {};
            var targetUrl = options.targetUrl || 'rtcpxr@rtcpxr.ringcentral.com:5060';
            var event = options.event || 'vq-rtcpxr';
            options.expires = 60;
            options.contentType = "application/vq-rtcpxr";
            options.extraHeaders = [];
            options.extraHeaders.push('p-rc-client-info:' + 'cpuRC=0:0;cpuOS=0:0;netType=' + networkType + ';ram=0:0');

            var body = createPublishBody(session);
            var pub = session.ua.publish(targetUrl, event, body, options);
            session.qosStatsObj.status = false;
            pub.close();
            session.emit('qos-published',body);
        }
        else{
            session.logger.error('QOS collection not started');
        }

    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     */
    function getQoSStatsTemplate() {
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

            netType: '',

            packetLost : 0,
            packetsReceived: 0,

            jitterBufferNominal: 0,
            jitterBufferMax: 0,

            jitterBufferDiscardRate: 0,

            totalSumJitter:0,
            totalIntervalCount:0,

            NLR : 0,
            JBM : 0 ,
            JBN :  0,
            JDR : 0,
            MOSLQ: 0,

            status : false
        }
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    /**
     * @this {SIP.Session}
     */
    function startQosStatsCollection(){
        var session =  this;
        session.qosStatsObj.callID = session.request.call_id||'';
        session.qosStatsObj.fromTag  = session.from_tag || '';
        session.qosStatsObj.toTag  = session.to_tag || '';
        session.qosStatsObj.localID = session.request.headers.From[0].raw||session.request.headers.From[0];
        session.qosStatsObj.remoteID = session.request.headers.To[0].raw||session.request.headers.To[0];
        session.qosStatsObj.origID = session.request.headers.From[0].raw||session.request.headers.From[0];
        getStat(session);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/


    function average(array) {
        var sum = array.reduce((a, b) => a + b, 0);
        var avg = (sum / array.length);
        return avg;
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    function addToMap(map, key, value) {
        if (key in map) {
            map[key] =  parseInt(map[key],10) + 1;
        } else {
            map[key] = parseInt(1);
        }
        return map;
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    //TODO: find relaible way to find network type , use navigator.connection.type?
    function getNetworkType(connectionType){
        var sysNetwork = connectionType.systemNetworkType || 'unknown';
        var localNetwork = connectionType.local.networkType || ['unknown'];

        if (!sysNetwork || sysNetwork === 'unknown') {
            return localNetwork[0];
        }
        return sysNetwork;
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    function getStat(session){
       
        var repeatInterval = session.ua.qosCollectInterval;
        var peer =  session.sessionDescriptionHandler.peerConnection;

        session.qosState = true;
        getStats(peer, function (getStatsResult){

            var qosStatsObj = Object.assign({}, session.qosStatsObj);

            session.getStatsResult = getStatsResult;
            qosStatsObj.status =  true;
            var network = getNetworkType(session.getStatsResult.connectionType);
            qosStatsObj.localAddr = session.getStatsResult.connectionType.local.ipAddress[0];
            qosStatsObj.remoteAddr = session.getStatsResult.connectionType.remote.ipAddress[0];
            session.getStatsResult.results.forEach(function (item) {
                if (item.type === 'ssrc' && item.transportId === 'Channel-audio-1' && item.id.includes('recv')) {
                    qosStatsObj.jitterBufferDiscardRate = item.googSecondaryDiscardedRate||0;
                    qosStatsObj.packetLost= item.packetsLost;
                    qosStatsObj.packetsReceived= item.packetsReceived;
                    qosStatsObj.totalSumJitter += parseFloat(item.googJitterBufferMs);
                    qosStatsObj.totalIntervalCount += 1;
                    qosStatsObj.JBM = Math.max(qosStatsObj.JBM, parseFloat(item.googJitterBufferMs));
                    qosStatsObj.netType = addToMap(session.netTypeObj,network, 0);
                }
            });
            session.qosStatsObj = qosStatsObj;
            console.error(session.qosStatsObj);

        }, repeatInterval);
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    function calculateNetworkUsage(session) {
            var networkType = [];
            for (var [key, value] of Object.entries(session.netTypeObj)) {
                networkType.push(key + ':' + ( value *100 / session.qosStatsObj.totalIntervalCount));
            }
            return networkType.join();
    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    function calculateStats(qosStatsObj){

        var rawNLR = qosStatsObj.packetLost* 100 / (qosStatsObj.packetsReceived+qosStatsObj.packetLost);
        var rawJBN = qosStatsObj.totalIntervalCount > 0 ? qosStatsObj.totalSumJitter / qosStatsObj.totalIntervalCount : 0;

        return Object.assign({}, qosStatsObj, {
            NLR:  parseFloat(rawNLR || 0).toFixed(2),
            //JitterBufferNominal
            JBN: parseFloat(rawJBN).toFixed(2),
            //JitterBufferDiscardRate
            JDR:  parseFloat(qosStatsObj.jitterBufferDiscardRate).toFixed(2),
            //MOS Score
            MOSLQ: 0
        });

    }

    /*--------------------------------------------------------------------------------------------------------------------*/

    function createPublishBody(session){

        var calculatedStats =  calculateStats(session.qosStatsObj);
        console.error(JSON.stringify(calculatedStats));

        var NLR =  calculatedStats.NLR||0;
        var JBM = calculatedStats.JBM||0;
        var JBN =  calculatedStats.JBN||0;
        var JDR = calculatedStats.JDR||0;
        var MOSLQ = calculatedStats.MOSLQ||0;

        var callID = calculatedStats.callID||'';
        var fromTag  = calculatedStats.fromTag||'';
        var toTag  = calculatedStats.toTag||'';
        var localId = calculatedStats.localID||'';
        var remoteId = calculatedStats.remoteID||'';

        var localAddr= calculatedStats.localAddr||'';
        var remoteAddr = calculatedStats.remoteAddr||'';

        var xrBody = 'VQSessionReport: CallTerm\r\n' +
            'CallID: ' + callID + '\r\n' +
            'LocalID: ' + localId + '\r\n' +
            'RemoteID: ' + remoteId + '\r\n' +
            'OrigID: ' + localId + '\r\n' +
            'LocalAddr: IP='+localAddr+' SSRC=0x00000000\r\n' +
            'RemoteAddr: IP='+remoteAddr+' SSRC=0x00000000\r\n' +
            'LocalMetrics:\r\n' +
            'Timestamps: START=0 STOP=0\r\n' +
            'SessionDesc: PT=0 PD=opus SR=0 FD=0 FPP=0 PPS=0 PLC=0 SSUP=on\r\n' +
            'JitterBuffer: JBA=0 JBR=0 JBN='+JBN+' JBM='+JBM+' JBX=0\r\n' +
            'PacketLoss: NLR='+NLR +' JDR='+JDR+'\r\n' +
            'BurstGapLoss: BLD=0 BD=0 GLD=0 GD=0 GMIN=0\r\n' +
            'Delay: RTD=0 ESD=0 SOWD=0 IAJ=0\r\n' +
            'QualityEst: MOSLQ='+MOSLQ+' MOSCQ=0.0\r\n' +
            'DialogID: ' + callID + ';to-tag=' + toTag  + ';from-tag=' + fromTag ;

        return xrBody;
    }

    //------------------QOS---------------------------------//

    return WebPhone;

}));
