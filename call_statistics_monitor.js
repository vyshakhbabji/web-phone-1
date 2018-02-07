var RC_Call_Statistics_Monitor = Backbone.Model.extend({
	defaults: function() {
		return {
			call_model : null,
			interval   : 5000,
			mos_type   : 'simple_emodel'
		};
	},
	start: function() {
		this.measures = [];
		this.mos = this[this.get('mos_type')];

		this.monitor_interval = setInterval(function() {
			var call_model = this.get('call_model');
			var session = call_model.get_sip_session();
			var call_stats = call_model.get('call_stats');

			if (!!session && !!session.mediaHandler && !!session.mediaHandler.peerConnection) {
				session.mediaHandler.peerConnection.getStats().then(function(stats) {
					var avgRtt;
					var mos;
					var rtt;
					var localCandidateId;
					var remoteCandidateId;
					var codec;
					var codecId;
					var stats_data = {
						timestamp: (new Date()).toISOString()
					};

					stats.forEach(function(stat) {
						if (!!stat.type) {
							// Chrome (<58)
							if (stat.type === 'ssrc') {
								if (typeof stat.timestamp != 'undefined' ) {
									stats_data.timestamp = (new Date(stat.timestamp)).toISOString();
								}
								if (typeof stat.googCodecName != 'undefined') {
									stats_data.codec = stat.googCodecName;
									call_stats.set_stats('codec', stats_data.codec);
								}
								if (typeof stat.bytesSent != 'undefined' ) {
									call_stats.set_stats('bytesSent', stat.bytesSent);
								}
								if (typeof stat.packetsSent != 'undefined' ) {
									call_stats.set_stats('packetsSent', stat.packetsSent);
								}
							}
							if (stat.type === 'googCandidatePair') {
								if (!!stat.googRtt) {
									stats_data.rtt = stat.googRtt ? parseInt(stat.googRtt, 10) : 0;
								}

								call_stats.set_stats('candidate-pair', stat);

								if (typeof stat.localCandidateId != 'undefined') {
									localCandidateId = stat.localCandidateId;
								}
								if (typeof stat.remoteCandidateId != 'undefined') {
									remoteCandidateId = stat.remoteCandidateId;
								}
							}
							// Firefox & Google Chrome (>=58)
							if (stat.type === 'inbound-rtp' && !stat.isRemote) {
								if (typeof stat.timestamp != 'undefined' ) {
									stats_data.timestamp = (new Date(stat.timestamp)).toISOString();
								}
								if (typeof stat.jitter != 'undefined') {
									stats_data.jitter = stat.jitter;
								}
								if (typeof stat.packetsLost != 'undefined') {
									stats_data.packetsLost = stat.packetsLost;
								}
								if (typeof stat.fractionLost != 'undefined') {
									stats_data.fractionLost = stat.fractionLost;
								}
								if (typeof stat.bytesReceived != 'undefined' ) {
									call_stats.set_stats('bytesReceived', stat.bytesReceived);
								}
								if (typeof stat.packetsReceived != 'undefined' ) {
									call_stats.set_stats('packetsReceived', stat.packetsReceived);
								}
								if (typeof stat.mozRtt != 'undefined' && stat.isRemote) {
									stats_data.rtt = stat.mozRtt;
								}
								if (typeof stat.codecId != 'undefined') {
									codecId = stat.codecId;
									if (stats.has(codecId)) {
										codec = stats.get(codecId);
										stats_data.codec = codec;
										call_stats.set_stats('codec', codec);
									}
								}
							}
							if (stat.type === 'outbound-rtp' && !stat.isRemote) {
								if (typeof stat.bytesSent != 'undefined' ) {
									call_stats.set_stats('bytesSent', stat.bytesSent);
								}
								if (typeof stat.packetsSent != 'undefined' ) {
									call_stats.set_stats('packetsSent', stat.packetsSent);
								}
							}

							// In Firefox there are multiple candidate-pairs with 'selected' field
							// In Google Chrome (>=58) there is only one candidate-pair and no 'selected' field
							if (stat.type === 'candidate-pair' && (!!stat.selected || typeof stat.selected === 'undefined')) {
								if (typeof stat.localCandidateId != 'undefined' ) {
									localCandidateId = stat.localCandidateId;
								}
								if (typeof stat.remoteCandidateId != 'undefined' ) {
									remoteCandidateId = stat.remoteCandidateId;
								}
								if (typeof stat.currentRoundTripTime != 'undefined' ) {
									stats_data.rtt = Math.round(1000 * stat.currentRoundTripTime);
								}
							}

							if (stat.type === 'local-candidate' && typeof stat.id != 'undefined' && localCandidateId === stat.id) {
								call_stats.set_stats('local-candidate', stat);
							}
							if (stat.type === 'remote-candidate' && typeof stat.id != 'undefined' && remoteCandidateId === stat.id) {
								call_stats.set_stats('remote-candidate', stat);
							}
						}
					});

					if (this.measures.length > 99) {
						this.measures.splice(20,1);
					}
					this.measures.push(stats_data);

					avgRtt = this.average(this.measures, 'rtt');
					result = this.mos(avgRtt);
					_.each(result, function(value, field) {
						call_stats.set_stats(field, value);
					});
					call_stats.set_stats('measures', this.measures);
				}.bind(this));
			}
		}.bind(this), this.get('interval'));
	},
	stop: function() {
		clearInterval(this.monitor_interval);
	},
	average: function(measures, field) {
		var sumValues = measures.reduce(function(sum, value){
			return sum + value[field];
		}, 0);
		return (sumValues / measures.length);
	},
	log10: function(x) {
		return (Math.log(x) / Math.log(10));
	},
	quality_category: function(r) {
		if (r >= 90 && r < 100) {
			return 'Best';
		} else if (r >= 80) {
			return 'High';
		} else if (r >= 70) {
			return 'Medium';
		} else if (r >= 60) {
			return 'Low';
		} else if (r < 60) {
			return 'Poor';
		}
	},
	/**
	 * emodel
	 *
	 * @param  integer  Round Trip Time in milliseconds
	 */
	emodel: function(rtt) {
		var SLR = 8;
		var RLR = 2;
		var STMR = 15;
		var LSTR = 18;
		var Ds = 3;
		var Dr = 3;
		var TELR = 65;
		var WEPL = 110;
		var T = rtt / 2;
		var Ta = T;
		var Tr = 2 * T;
		var qdu = 1;
		var Ie = 0;
		var Bpl = 1;
		var Ppl = 0;
		var Nc = -70;
		var Nfor = -64;
		var Ps = 35;
		var Pr = 35;
		var A = 0;

		var LSTR = STMR + Dr;
		var OLR = SLR + RLR;
		var Nfo = Nfor + RLR;
		var Pre = Pr + 10 * this.log10(1 + Math.pow(10, (10 - LSTR) / 10)) / this.log10(10);
		var Nor = RLR - 121 + Pre + 0.008 * (Pre - 35.2) * (Pre - 35.2);
		var Nos = Ps - SLR - Ds - 100 + 0.004 * (Ps - OLR - Ds - 14) * (Ps - OLR - Ds - 14);
		var No = 10 * this.log10(Math.pow(10, (Nc / 10)) + Math.pow(10, (Nos / 10)) + Math.pow(10, (Nor / 10)) + Math.pow(10, (Nfo / 10)));
		var Ro = 15 - 1.5 * (SLR + No);

		var Xolr = OLR + 0.2 * (64 + No - RLR);
		var Iolr = 20 * (Math.pow((1 + Math.pow((Xolr / 8), 8)), 0.125) - Xolr / 8);
		var STMRo = -10 * this.log10(Math.pow(10, (-STMR / 10)) + Math.exp(-T / 4) * Math.pow(10, (-TELR / 10)));
		var Ist = 12 * Math.pow(1 + Math.pow((STMRo - 13) / 6, 8), 0.125);
		Ist -= 28 * Math.pow(1 + Math.pow((STMRo + 1) / 19.4, 35), (1 / 35));
		Ist += -13 * Math.pow(1 + Math.pow((STMRo - 3) / 33, 13), (1 / 13)) + 29;

		if (qdu < 1) {
			qdu = 1;
		}
		Q = 37 - 15 * this.log10(qdu) / this.log10(10);

		var G = 1.07 + 0.258 * Q + 0.0602 * Q * Q;
		var Z = 46 / 30 - G / 40;
		var Y = (Ro - 100) / 15 + 46 / 8.4 - G / 9;
		var Iq = 15 * this.log10(1 + Math.pow(10, Y) + Math.pow(10, Z));
		var Is = Iolr + Ist + Iq;

		var TERV = TELR - 40 * this.log10((1 + T / 10) / (1 + T / 150)) + 6 * Math.exp(-0.3 * T * T);
		if (STMR < 9) {
			TERV = TERV + Ist / 2;
		}
		var Re = 80 + 2.5 * (TERV - 14);

		var Roe = -1.5 * (No - RLR);

		var Idte = ((Roe - Re) / 2 + Math.sqrt((Roe - Re) * (Roe - Re) / 4 + 100) - 1) * (1 - Math.exp(-T));
		if (STMR > 20) {
			Idte = Math.sqrt(Idte * Idte + Ist * Ist);
		}
		if (T < 1) {
			Idte = 0;
		}

		var Rle = 10.5 * (WEPL + 7) * Math.pow((Tr + 1), (-0.25));
		var Idle = (Ro - Rle) / 2 + Math.sqrt((Ro - Rle) * (Ro - Rle) / 4 + 169);

		var Idd;
		var sT = 1;
		var mT = 100;
		var X;
		if (Ta == 0) {
			X = 0;
		} else {
			X = this.log10(Ta / mT) / this.log10(2);
		}
		if (Ta > mT) {
			Idd = 25 * (Math.pow((1 + Math.pow(X, 6)), (1 / 6)) - 3 * Math.pow((1 + Math.pow(X / 3, 6)), (1 / 6)) + 2);
		} else {
			Idd = 0;
		}

		var Id = Idte + Idle + Idd;
		var BurstR = 1.0;
		var Ie_eff = Ie + (95 - Ie) * Ppl / (Ppl/BurstR + Bpl);

		var R = Ro - Is - Id - Ie_eff + A;

		var MOS = 0;
		if (R < 0) {
			MOS = 1;
		} else if (R >= 0 && R <= 100) {
			MOS = 1 + 0.035 * R + R * (R - 60) * (100 - R) * 7 * Math.pow(10, -6);
		} else if (R > 100) {
			MOS = 4.5;
		}

		var category = this.quality_category(R);

		return {
			rfactor: R.toFixed(2),
			quality_category: category,
			mos: MOS.toFixed(2)
		};
	},
	simple_emodel: function(rtt) {
		var emodel = 0;
		var halfRtt = rtt/2;

		if (halfRtt >= 500) {
			emodel = 1;
		} else if (halfRtt >= 400) {
			emodel = 2;
		} else if (halfRtt >= 300 ) {
			emodel = 3;
		} else if (halfRtt >= 200 ) {
			emodel = 4;
		} else if (halfRtt < 200 ) {
			emodel = 5;
		}
		return {
			mos: emodel
		};
	}
});
