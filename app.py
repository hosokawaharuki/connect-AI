import os
import subprocess
import threading
import sqlalchemy
from flask import Flask, render_template, request, redirect, url_for, flash
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from flask_socketio import SocketIO, emit, join_room
import openai
from werkzeug.security import generate_password_hash, check_password_hash

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

os.environ['TAVILY_API_KEY'] = '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'

try:
    from tavily import TavilyClient
    tavily_available = True
except ImportError:
    tavily_available = False

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'conect_ai_super_secret_key')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///app.db'
db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading', max_http_buffer_size=50 * 1024 * 1024)

login_manager = LoginManager(app)
login_manager.login_view = 'login'

def start_ollama_automatically():
    if os.environ.get('RENDER'):
        return
    try:
        subprocess.Popen(
            ["ollama", "run", "qwen2.5:1.5b"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        )
    except Exception as e:
        pass

class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(150), unique=True, nullable=False)
    password = db.Column(db.String(150), nullable=False)

class ChatMessage(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    message = db.Column(db.Text, nullable=False)
    read_count = db.Column(db.Integer, default=1)
    is_deleted = db.Column(db.Boolean, default=False)
    timestamp = db.Column(db.DateTime, default=db.func.current_timestamp())

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

@app.route('/')
@login_required
def index():
    return render_template('index.html', username=current_user.username)

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        if User.query.filter_by(username=username).first():
            flash('そのユーザー名は既に使用されています。')
            return redirect(url_for('register'))
        hashed_pw = generate_password_hash(password, method='pbkdf2:sha256')
        new_user = User(username=username, password=hashed_pw)
        db.session.add(new_user)
        db.session.commit()
        return redirect(url_for('login'))
    return render_template('register.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        user = User.query.filter_by(username=username).first()
        if user and check_password_hash(user.password, password):
            login_user(user)
            return redirect(url_for('index'))
        flash('ユーザー名またはパスワードが間違っています。')
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

@socketio.on('join')
def on_join(data):
    room = data.get('room', 'main_room')
    username = data.get('username', 'ゲスト')
    join_room(room)
    emit('user_joined', {'username': username}, to=room)

@socketio.on('draw')
def on_draw(data):
    room = data.get('room', 'main_room')
    emit('draw_sync', data, to=room, include_self=False)

@socketio.on('webrtc_offer')
def on_offer(data):
    room = data.get('room', 'main_room')
    emit('webrtc_offer', data, to=room, include_self=False)

@socketio.on('webrtc_answer')
def on_answer(data):
    room = data.get('room', 'main_room')
    emit('webrtc_answer', data, to=room, include_self=False)

@socketio.on('webrtc_ice_candidate')
def on_ice_candidate(data):
    room = data.get('room', 'main_room')
    emit('webrtc_ice_candidate', data, to=room, include_self=False)

@socketio.on('send_message')
def on_message(data):
    msg = data.get('message', '')
    file_data = data.get('file', None)
    file_type = data.get('file_type', '')
    file_name = data.get('file_name', 'file')
    room = data.get('room', 'main_room')
    username = data.get('username', 'システムユーザー')
    
    display_msg = msg if msg else f"[ファイル送信: {file_name}]"
    
    user = User.query.filter_by(username=username).first()
    user_id = user.id if user else (current_user.id if current_user.is_authenticated else 1)
    
    with app.app_context():
        new_msg = ChatMessage(user_id=user_id, message=display_msg, read_count=1, is_deleted=False)
        db.session.add(new_msg)
        db.session.commit()
        msg_id = new_msg.id
    
    socketio.emit('receive_message', {
        'id': msg_id,
        'user': username, 
        'message': msg, 
        'file': file_data, 
        'file_type': file_type,
        'file_name': file_name,
        'read_count': 1
    }, room=room)

@socketio.on('delete_message')
def on_delete_message(data):
    msg_id = data.get('id')
    room = data.get('room', 'main_room')
    with app.app_context():
        msg = ChatMessage.query.get(msg_id)
        if msg:
            msg.is_deleted = True
            db.session.commit()
    socketio.emit('message_deleted', {'id': msg_id}, room=room)

def async_ai_task(prompt, app_instance, room):
    with app_instance.app_context():
        try:
            search_context = ""
            if tavily_available:
                try:
                    tavily = TavilyClient(api_key=os.environ.get('TAVILY_API_KEY'))
                    search_result = tavily.search(query=prompt, max_results=2)
                    results = search_result.get('results', [])
                    snippets = [r.get('content', '') for r in results if r.get('content')]
                    if snippets:
                        search_context = "\n".join(snippets[:2])
                except Exception:
                    pass

            full_prompt = f"質問: {prompt}\n\n参考情報:\n{search_context if search_context else 'なし'}\n\n指示: 上記の質問に対し、関係のない情報を混ぜず、簡潔かつ正確に日本語で答えてください。"

            answer_text = ""
            openai_api_key = os.environ.get('OPENAI_API_KEY')
            
            # 1. まずOpenAIでの応答を試みる
            try:
                if not openai_api_key:
                    raise ValueError("APIキー未設定")
                
                client = openai.OpenAI(api_key=openai_api_key)
                response = client.chat.completions.create(
                    model="gpt-4o-mini", 
                    messages=[
                        {"role": "system", "content": "あなたは正確で簡潔なAIアシスタントです。質問に対して嘘をつかず、関係のない話題に脱線しないで答えてください。"},
                        {"role": "user", "content": full_prompt}
                    ],
                    max_tokens=250,
                    temperature=0.7,
                    timeout=25
                )
                answer_text = response.choices[0].message.content.strip()
            except Exception as openai_err:
                # 2. OpenAIでエラー（残高不足429や認証エラー）が発生した場合、ローカルのOllamaへ自動フォールバック
                try:
                    local_client = openai.OpenAI(
                        base_url="http://localhost:11434/v1",
                        api_key="ollama"
                    )
                    local_response = local_client.chat.completions.create(
                        model="qwen2.5:1.5b", 
                        messages=[
                            {"role": "system", "content": "あなたは正確で簡潔なAIアシスタントです。質問に対して嘘をつかず、関係のない話題に脱線しないで答えてください。"},
                            {"role": "user", "content": full_prompt}
                        ],
                        max_tokens=250,
                        temperature=0.7,
                        timeout=25
                    )
                    answer_text = local_response.choices[0].message.content.strip() + "\n(※OpenAI制限のためローカルAIで応答)"
                except Exception as local_err:
                    answer_text = f"⚠️ AI応答エラー (OpenAI残高不足 & ローカルAI接続失敗): {str(openai_err)}"

        except Exception as e:
            answer_text = f"⚠️ AI処理エラー: {str(e)}"
        
        try:
            system_user = User.query.first()
            uid = system_user.id if system_user else None
            new_msg = ChatMessage(user_id=uid, message=answer_text, read_count=1, is_deleted=False)
            db.session.add(new_msg)
            db.session.commit()
            msg_id = new_msg.id
        except Exception:
            db.session.rollback()
            msg_id = 9999

        socketio.emit('receive_message', {
            'id': msg_id,
            'user': '🤖 AIアドバイザー', 
            'message': answer_text,
            'read_count': 1
        }, room=room)

@socketio.on('ask_ai')
def on_ask_ai(data):
    prompt = data.get('prompt', 'ブレインストーミングの提案をしてください。')
    room = data.get('room', 'main_room')
    
    socketio.emit('receive_message', {
        'id': 0,
        'user': '🤖 AIアドバイザー',
        'message': f'「{prompt}」について思考中...',
        'read_count': 1
    }, room=room)
    
    thread = threading.Thread(target=async_ai_task, args=(prompt, app, room))
    thread.daemon = True
    thread.start()

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
        inspector = sqlalchemy.inspect(db.engine)
        if 'chat_message' in inspector.get_table_names():
            columns = [col['name'] for col in inspector.get_columns('chat_message')]
            with db.engine.connect() as conn:
                if 'read_count' not in columns:
                    conn.execute(sqlalchemy.text('ALTER TABLE chat_message ADD COLUMN read_count INTEGER DEFAULT 1'))
                    conn.commit()
                if 'is_deleted' not in columns:
                    conn.execute(sqlalchemy.text('ALTER TABLE chat_message ADD COLUMN is_deleted BOOLEAN DEFAULT 0'))
                    conn.commit()

    start_ollama_automatically()
    socketio.run(app, debug=True, host='0.0.0.0', port=5000, allow_unsafe_werkzeug=True)