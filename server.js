var express = require('express');
var app = express();
var cronJob = require('cron').CronJob;
var http = require('http');
var async = require('async');

app.use(express.logger());

var port = process.env.PORT || 5000;

app.listen(port, function() {
  console.log('Server listening on %s', port);
});

var matchesAndVersions = {};
const defaultVersion = -1;
var allDataFetched = true;

var fetchingJob = function () {
	if (allDataFetched) {
		allDataFetched = false;
		fetchData();
	} else {
		console.warn('[NOT READY] Data fetcher is still running, skipping this iteration');
	}
    setTimeout(fetchingJob, 1000);
}
fetchingJob();

/**
 * Receive data fetch requests
 */
app.get('/fetchlist/new/:id', function(request, response) {
  var requestedMatchId = request.params.id;

  if(!requestedMatchId || requestedMatchId < 0) {
    console.warn('Bad Request: Invalid parameters');
    response.statusCode = 400;
    return response.send('Bad Request');
  }

  if (matchesAndVersions[requestedMatchId]) {
  	console.warn('This match information is in the fetchlist already. Match id: %s', requestedMatchId);
  	return response.send('This match information is in the fetchlist already');
  }

  matchesAndVersions[requestedMatchId] = defaultVersion;

  console.log('Successfully added match (id: %s) to the fetchlist. Current fetchlist:');
  console.log(JSON.stringify(matchesAndVersions, null, 4));

  response.send('Success');
});

function fetchData() {
  console.log('Starting to fetch data');

  var options = {
    host: 'nameless-retreat-3788.herokuapp.com',
    port: 80,
    method: 'GET'
  };

  console.log('[BEGIN] Begin fetching match data');

  async.forEach(Object.keys(matchesAndVersions), function (matchId, callback) { 
    var updatedMatchData;

    options.path = '/matchesfeed/' + matchId + '/matchcentre';

    var req = http.get(options, function(res) {
      var updatedMatchData = '';
      res.setEncoding('utf8');

      res.on('data', function (chunk) {
        updatedMatchData += chunk;
        console.log('Received some data from data source: %s', updatedMatchData);
      });

      res.on('end', function(){
        var updatedMatch;
        try {
        	updatedMatch = JSON.parse(updatedMatchData);
        } catch (e) {
        	console.error('Did not receive proper JSON object from data provider for match %s', matchId);
        }

        var existingVersion = matchesAndVersions[matchId];
        var newVersion;

        if (updatedMatch) {
        	newVersion = updatedMatch['version'];
        }

        if (updatedMatch && isNumber(existingVersion) && isNumber(newVersion)) {
        	console.log('For match %s, current version is %s, new version is %s', matchId, existingVersion, newVersion);	

        	if (newVersion > existingVersion) {
        		broadcastNewMatchData();
        	} else {
        		console.log('No changes detected for match %s', matchId)
        	}
        } else {
        	console.error('Could not receive new match data or it was corrupt');
        }

        console.log('All data for match %s has been received', matchId);
        callback();
      });

      res.on('error', function(e) {
	    console.error('Can not fetch match data: %s', e.message);
	  });
    });
	}, function(err) {
		if (err) {
			console.error('Cant fetch match data: %s', err);	
		} 
	    
		allDataFetched = true; 
		console.log('[COMPLETE] Data fetch is complete');
	}); 
}

function broadcastNewMatchData() {

}

function isNumber(n) {
  return !isNaN(parseFloat(n)) && isFinite(n);
}