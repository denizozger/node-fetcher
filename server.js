'use strict';

const 
  zmq = require('zmq'),
  cluster = require('cluster'),
  log = require('npmlog');

const DATA_PROVIDER_HOST = process.env.DATA_PROVIDER_HOST || 'localhost';
const DATA_PROVIDER_PORT = process.env.DATA_PROVIDER_PORT || 3000;
const TO_FETCH = 'to-fetch';
const FETCHED = 'fetched';
const DEFAULT_MAX_AGE = 5;

log.level = process.env.LOGGING_LEVEL || 'verbose';

/**
 * Master process
 */ 
if (cluster.isMaster) {

  log.info('Master ' + process.pid +' is online.');

  const request = require('request'); 

  var fetchJobs = {}; // key = resourceId, value = job
  const totalWorkerCount = require('os').cpus().length;
  var readyWorkerCount = 0;
  const fetchJobCheckFrequencyInMilis = 250;

  // Receive resource required messages from WebSocketServer
  const resourceRequiredPuller = zmq.socket('pull').connect('tcp://localhost:5432');
  // Publish resource data to WebSocketServer
  const resourceUpdatedPublisher = zmq.socket('push').bind('tcp://*:5433', socketErrorHandler);

  // Push resource fetch jobs to workers
  const resourceFetchJobPusher = zmq.socket('push').bind('ipc://resource-fetch-job-pusher.ipc', socketErrorHandler);
  // Pull the result of fetch jobs (ie. resource data)
  const resourceFetchJobResultPuller = zmq.socket('pull').bind('ipc://resource-fetch-job-result-puller.ipc', socketErrorHandler);

  resourceRequiredPuller.on('message', function (message) {
      handleResourceRequested(message);    
  });

  function pushJobsToWorkers() {
    for (var fetchJobId in fetchJobs) {
      if (fetchJobs.hasOwnProperty(fetchJobId) && areAllWorkersReady()) {
        var fetchJob = fetchJobs[fetchJobId];

        if (!fetchJob.timeToFetchAgain) {
          delete fetchJobs[fetchJob.id];
          fetchJob = null;
        } else if (fetchJob.timeToFetchAgain <= Date.now()) { 
          fetchJob.data = null;

          resourceFetchJobPusher.send(JSON.stringify(fetchJob));
        }   
      }
    }

    setTimeout(function () {
      pushJobsToWorkers();
    }, fetchJobCheckFrequencyInMilis);
  }

  pushJobsToWorkers();

  function handleResourceRequested(message) {
    var resourceId = JSON.parse(message).id;

    if (fetchJobs[resourceId]) {
      log.verbose('This resource is in fetch queue already: ' + resourceId);
      return;
    }

    var fetchJob = {
      id: resourceId,
      data: null,
      timeToFetchAgain : Date.now()
    };

    fetchJobs[resourceId] = fetchJob;

    if (areAllWorkersReady()) {
      resourceFetchJobPusher.send(JSON.stringify(fetchJob));  

      log.silly('Pushed a fetch job for ' + fetchJob.id);
    } else {
      // TODO do we really care?
    }
  }

  resourceFetchJobResultPuller.on('message', function (data) {
    handleMessageFromWorker(data); 
  });

  function handleMessageFromWorker(data) {
    var message = JSON.parse(data);

    if (message.ready) {
      readyWorkerCount += 1;
      log.info('Worker ' + message.pid + ' is ready. (' + 
        readyWorkerCount + ' out of ' + totalWorkerCount + ')');

      if (areAllWorkersReady()) {
        pushAllJobs();
      }
    } else {
      handleResourceFetchJobResult(message);
    }
  }

  function handleResourceFetchJobResult(fetchJob) {
    log.silly('Master pulled new resource: ' + JSON.stringify(fetchJob));  

    publishResourceReceived(fetchJob);

    fetchJob.data = null;

    fetchJobs[fetchJob.id] = fetchJob;
  }

  function pushAllJobs() {
    log.silly('Pushing all jobs');

    for (var fetchJobId in fetchJobs) {
      if (fetchJobs.hasOwnProperty(fetchJobId)) {
        resourceFetchJobPusher.send(JSON.stringify(fetchJobs[fetchJobId]));  

        log.silly('Pushed a fetch job for ' + fetchJobs[fetchJobId]);   
      }
    }
  }

  function publishResourceReceived(fetchJob) {
    log.verbose('Master sending updated data of ' + fetchJob.id + ' to web socket server.');

    resourceUpdatedPublisher.send(JSON.stringify({
      id: fetchJob.id, 
      data: fetchJob.data
    }));
  }

  /**
   * Forking worker processes
   */
  
  for (let i = 0; i < totalWorkerCount; i++) {
    cluster.fork();  
  }

  // Listen for workers to come online
  cluster.on('online', function(worker) {
    log.info('Worker ' + worker.process.pid + ' is online.');
  });

  // Handle dead workers
  cluster.on('exit', function(worker, code, signal) {
    log.warn('Worker ' + worker.process.pid + ' died with code ' + code + '. Forking a new one..');
    this.fork();
  });

  function areAllWorkersReady() {
    return readyWorkerCount === totalWorkerCount;
  }

  function closeAllSockets() {
    resourceRequiredPuller.close();
    resourceUpdatedPublisher.close();
    resourceFetchJobPusher.close();
    resourceFetchJobResultPuller.close();
  }

  process.on('uncaughtException', function (err) {
    log.error('Master process failed, gracefully closing connections: ' + err.stack);    
    closeAllSockets();
    process.exit(1);
  }); 

  process.on('SIGINT', function() {
    log.warn('Master | SIGINT detected, exiting gracefully.');
    closeAllSockets();
    process.exit();
  });

} else {

  /**
   * Worker process
   */
  const 
    http = require('http'),
    request = require('request');

  // Pull resource fetch jobs from the master 
  const resourceFetchJobPuller = zmq.socket('pull').connect('ipc://resource-fetch-job-pusher.ipc');
  // Push resource fetch result (ie. resource data) to master
  const resourceFetchJobResultPusher = zmq.socket('push').connect('ipc://resource-fetch-job-result-puller.ipc');

  // Receive fetch jobs from the master
  resourceFetchJobPuller.on('message', function (message) {
    handleNewFetchJob(message);
  });

  function handleNewFetchJob(message) {
    var fetchJob = JSON.parse(message);

    log.silly('Worker ' + process.pid + ' received a fetch job for resource ' + fetchJob.id);

    fetchResource(fetchJob.id);
  }

  function fetchResource(resourceId) {
    var resourceURL = '/' + resourceId;

    var httpGetOptions = {
      host: DATA_PROVIDER_HOST,
      port: DATA_PROVIDER_PORT,
      method: 'GET',
      path: resourceURL
    };

    log.http('Worker ' + process.pid + ' requested resource ' + resourceId + ' from datafetcher ' + 
      DATA_PROVIDER_HOST + ':' + DATA_PROVIDER_PORT + resourceURL);

    http.get(httpGetOptions, function (response) {
      resourceReceived(resourceId, response);
    }).on('error', function(error) {
      log.error('Worker ' + process.pid + ' cant request resource ' + resourceId + ' :' + error.stack);     
      removeJobFromTheQueue({id : resourceId});
    });
  }

  function resourceReceived(resourceId, response) {
    var responseBody = '';
    response.setEncoding('utf8');

    response.on('data', function (chunk) {
      responseBody += chunk;
    });

    response.on('end', function() {

      if (response.statusCode === 200) {
        log.http('Worker ' + process.pid + ' received new resource data for resource ' + 
        resourceId);

        var lastModified = getLastModifiedFromResponse(response);
        var maxAge = getMaxAgeFromResponse(response);

        var fetchJob = {
          id : resourceId,
          data: responseBody,
          timeToFetchAgain : maxAge > 0 ? lastModified + maxAge : null
        };

        resourceFetchJobResultPusher.send(JSON.stringify(fetchJob)); 
      } else {
        log.warn('Bad response (' + response.statusCode + ' ' + 
          http.STATUS_CODES[response.statusCode] + ') for resource (' + resourceId + ')');
        
        removeJobFromTheQueue({id : resourceId});
      }           
    });
  }

  function removeJobFromTheQueue(fetchJob) {
    log.warn('Removing ' + fetchJob.id + ' from the fetch job list');

    fetchJob.timeToFetchAgain = null;
    resourceFetchJobResultPusher.send(JSON.stringify(fetchJob));
  }

  function getLastModifiedFromResponse(response) {
    var lastModifiedHeader = response.headers['last-modified'];

    return lastModifiedHeader ? Date.parse(lastModifiedHeader) : Date.now();
  }

  function getMaxAgeFromResponse(response) {
    var cacheControlHeader = response.headers['cache-control'];
    var maxAge = getPropertyValueFromResponseHeader(cacheControlHeader, 'max-age');

    return (maxAge ? maxAge : DEFAULT_MAX_AGE) * 1000;
  }

  function getPropertyValueFromResponseHeader(responseHeaderValue, propertyName) {
    if (responseHeaderValue) {
      var indexOfProperty = responseHeaderValue.indexOf(propertyName);

      return responseHeaderValue.substring(propertyName.length + 1, responseHeaderValue.length + 1);
    } 
    
    return '';
  }

  function closeAllSockets() {
    resourceFetchJobPuller.close();
    resourceFetchJobResultPusher.close(); 
  }

  // signal ready
  resourceFetchJobResultPusher.send(JSON.stringify({
    ready: true,
    pid: process.pid
  }));

  process.on('uncaughtException', function (err) {
    log.error('Worker ' + process.pid + ' got an error, the job it was working on is lost: ' + err.stack);    
    closeAllSockets();
    process.exit(1);
  }); 

  process.on('SIGINT', function() {
    closeAllSockets();
    process.exit();
  });
}

var socketErrorHandler = function (err) {
    if (err) {
      log.error('Socket connection error: ' + err.stack);
      throw new Error(err);
    }
    log.info('Socket open.');
};



    
