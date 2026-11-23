// Runs a shell script on the Lightsail server using Jenkins credentials
def remote(String script) {
    withCredentials([
        sshUserPrivateKey(credentialsId: 'lightsail-ssh',
                          keyFileVariable: 'SSH_KEY',
                          usernameVariable: 'SSH_USER'),
        string(credentialsId: 'lightsail-host', variable: 'SSH_HOST')
    ]) {
        writeFile file: 'remote.sh', text: script
        sh '''
            ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
                "$SSH_USER@$SSH_HOST" 'bash -s' < remote.sh
        '''
    }
}

pipeline {
    agent any

    options {
        timestamps()
        disableConcurrentBuilds()
        timeout(time: 30, unit: 'MINUTES')
    }

    environment {
        IMAGE   = 'vaultrealm'
        TAG     = "${env.BUILD_NUMBER}"
        APP_DIR = '/opt/vaultrealm'
    }

    stages {
        stage('Checkout') {
            steps { checkout scm }
        }

        stage('Build image') {
            when { branch 'master' }
            steps {
                sh '''
                    docker build --platform linux/amd64 \
                        -t $IMAGE:$TAG -t $IMAGE:latest .
                '''
            }
        }

        stage('Ship & deploy') {
            when { branch 'master' }
            steps {
                withCredentials([
                    sshUserPrivateKey(credentialsId: 'lightsail-ssh',
                                      keyFileVariable: 'SSH_KEY',
                                      usernameVariable: 'SSH_USER'),
                    string(credentialsId: 'lightsail-host', variable: 'SSH_HOST')
                ]) {
                    sh '''
                        set -euo pipefail
                        SSH_OPTS="-i $SSH_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
                        REMOTE="$SSH_USER@$SSH_HOST"

                        ssh $SSH_OPTS $REMOTE "mkdir -p $APP_DIR"
                        scp $SSH_OPTS docker-compose.yml Caddyfile $REMOTE:$APP_DIR/

                        docker save $IMAGE:latest $IMAGE:$TAG | gzip \
                            | ssh $SSH_OPTS $REMOTE 'gunzip | docker load'

                        ssh $SSH_OPTS $REMOTE "cd $APP_DIR && docker compose up -d --no-build --remove-orphans && docker image prune -f"
                    '''
                }
            }
        }

        stage('Health check') {
            when { branch 'master' }
            steps {
                script {
                    remote('''
                        set -u
                        cd /opt/vaultrealm
                        for i in $(seq 1 12); do
                          if docker compose exec -T panel wget -qO- http://localhost:3001/healthz >/dev/null 2>&1; then
                            echo "Healthy"; exit 0
                          fi
                          sleep 5
                        done
                        echo "Health check failed"; exit 1
                    ''')
                }
            }
        }
    }

    post {
        failure { echo 'Deploy failed, check the console output.' }
        always  { sh 'docker image prune -f || true' }
    }
}