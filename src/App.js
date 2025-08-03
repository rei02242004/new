import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, onSnapshot, addDoc, serverTimestamp, updateDoc, doc, deleteDoc } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';

// Firebaseのグローバル変数
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Firebaseアプリの初期化
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);

// エラー時の再試行を処理するヘルパー関数
const withExponentialBackoff = async (fn, retries = 5, delay = 1000) => {
    try {
        return await fn();
    } catch (error) {
        if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
            return withExponentialBackoff(fn, retries - 1, delay * 2);
        } else {
            throw error;
        }
    }
};

// メインのアプリケーションコンポーネント
const App = () => {
    const [progressItems, setProgressItems] = useState([]);
    const [userId, setUserId] = useState(null);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [selectedFile, setSelectedFile] = useState(null);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState(null);
    const [editingItem, setEditingItem] = useState(null);
    const [editTitle, setEditTitle] = useState('');
    const [editDescription, setEditDescription] = useState('');

    // Firebase認証とデータ購読のためのエフェクト
    useEffect(() => {
        const setupFirebase = async () => {
            try {
                if (initialAuthToken) {
                    await withExponentialBackoff(() => signInWithCustomToken(auth, initialAuthToken));
                } else {
                    await withExponentialBackoff(() => signInAnonymously(auth));
                }
            } catch (err) {
                console.error("Firebase認証エラー:", err);
                setError("認証に失敗しました。");
                setLoading(false);
                return;
            }

            const unsubscribe = onAuthStateChanged(auth, (user) => {
                if (user) {
                    setUserId(user.uid);
                    setLoading(false);
                    const progressCollectionPath = `/artifacts/${appId}/users/${user.uid}/progress_timeline`;
                    const q = query(collection(db, progressCollectionPath));

                    // リアルタイムの更新を監視
                    const unsubscribeSnapshot = onSnapshot(q, async (snapshot) => {
                        const items = await Promise.all(snapshot.docs.map(async doc => {
                            const data = doc.data();
                            const commentsCollectionPath = `/artifacts/${appId}/users/${user.uid}/progress_timeline/${doc.id}/comments`;
                            const commentsQuery = query(collection(db, commentsCollectionPath));

                            const commentsSnapshot = await new Promise((resolve) => {
                                const unsubscribeComments = onSnapshot(commentsQuery, (snapshot) => {
                                    unsubscribeComments(); // 最初のスナップショット後に購読を解除
                                    resolve(snapshot);
                                });
                            });

                            const comments = commentsSnapshot.docs.map(commentDoc => ({
                                id: commentDoc.id,
                                ...commentDoc.data(),
                                timestamp: commentDoc.data().timestamp?.toDate()
                            }));

                            return {
                                id: doc.id,
                                ...data,
                                timestamp: data.timestamp?.toDate(),
                                comments: comments
                            };
                        }));

                        items.sort((a, b) => b.timestamp - a.timestamp); // タイムスタンプの降順でソート
                        setProgressItems(items);
                    }, (err) => {
                        console.error("Firestoreエラー:", err);
                        setError("進捗データの取得に失敗しました。");
                    });

                    return () => unsubscribeSnapshot();
                } else {
                    setUserId(null);
                    setLoading(false);
                }
            });

            return () => unsubscribe();
        };

        setupFirebase();
    }, []);

    // 新しい進捗アイテムを追加するハンドラ
    const handleAddProgress = async (e) => {
        e.preventDefault();
        if (!userId) {
            setError("ユーザー認証が完了していません。");
            return;
        }
        if (title.trim() === '' || !selectedFile) {
            setError("タイトルと画像は必須です。");
            return;
        }

        setUploading(true);

        try {
            // 画像をFirebase Storageにアップロード
            const storageRef = ref(storage, `images/${userId}/${Date.now()}_${selectedFile.name}`);
            const snapshot = await withExponentialBackoff(() => uploadBytes(storageRef, selectedFile));
            const imageUrl = await withExponentialBackoff(() => getDownloadURL(snapshot.ref));

            // 進捗アイテムをFirestoreに追加
            const progressCollectionPath = `/artifacts/${appId}/users/${userId}/progress_timeline`;
            await withExponentialBackoff(() => addDoc(collection(db, progressCollectionPath), {
                title,
                description,
                imageUrl,
                timestamp: serverTimestamp(),
            }));
            setTitle('');
            setDescription('');
            setSelectedFile(null);
            setError(null);
        } catch (err) {
            console.error("進捗追加エラー:", err);
            setError("進捗の追加に失敗しました。");
        } finally {
            setUploading(false);
        }
    };

    // コメントを追加するハンドラ
    const handleAddComment = async (e, progressId) => {
        e.preventDefault();
        const comment = e.target.elements.comment.value;
        if (!comment.trim()) return;

        if (!userId) {
            setError("ユーザー認証が完了していません。");
            return;
        }

        try {
            const commentsCollectionPath = `/artifacts/${appId}/users/${userId}/progress_timeline/${progressId}/comments`;
            await withExponentialBackoff(() => addDoc(collection(db, commentsCollectionPath), {
                text: comment,
                timestamp: serverTimestamp(),
            }));
            e.target.elements.comment.value = '';
        } catch (err) {
            console.error("コメント追加エラー:", err);
            setError("コメントの追加に失敗しました。");
        }
    };

    // 編集を開始するハンドラ
    const handleEditStart = (item) => {
        setEditingItem(item.id);
        setEditTitle(item.title);
        setEditDescription(item.description);
    };

    // 編集をキャンセルするハンドラ
    const handleEditCancel = () => {
        setEditingItem(null);
        setEditTitle('');
        setEditDescription('');
    };

    // 進捗を更新するハンドラ
    const handleUpdate = async (e, itemId) => {
        e.preventDefault();
        if (editTitle.trim() === '') {
            setError("タイトルは必須です。");
            return;
        }

        if (!userId) {
            setError("ユーザー認証が完了していません。");
            return;
        }

        try {
            const itemRef = doc(db, `/artifacts/${appId}/users/${userId}/progress_timeline`, itemId);
            await withExponentialBackoff(() => updateDoc(itemRef, {
                title: editTitle,
                description: editDescription
            }));
            setEditingItem(null);
            setError(null);
        } catch (err) {
            console.error("更新エラー:", err);
            setError("進捗の更新に失敗しました。");
        }
    };
    
    // 進捗を削除するハンドラ
    const handleDelete = async (itemId, imageUrl) => {
        if (!window.confirm("この記録を削除してもよろしいですか？")) return;

        if (!userId) {
            setError("ユーザー認証が完了していません。");
            return;
        }

        try {
            // Firebase Storageから画像を削除
            const imageRef = ref(storage, imageUrl);
            await withExponentialBackoff(() => deleteObject(imageRef));

            // Firestoreからアイテムを削除
            const itemRef = doc(db, `/artifacts/${appId}/users/${userId}/progress_timeline`, itemId);
            await withExponentialBackoff(() => deleteDoc(itemRef));
            setError(null);
        } catch (err) {
            console.error("削除エラー:", err);
            setError("記録の削除に失敗しました。");
        }
    };


    if (loading) {
        return <div className="flex items-center justify-center min-h-screen text-gray-500">読み込み中...</div>;
    }

    return (
        <div className="bg-gray-50 min-h-screen font-sans antialiased text-gray-800">
            <header className="bg-white shadow-sm p-4 sticky top-0 z-10">
                <div className="container mx-auto flex justify-between items-center">
                    <h1 className="text-3xl font-extrabold text-gray-900">卒業制作 記録サイト</h1>
                    {userId && (
                        <div className="text-sm text-gray-500">
                            ユーザーID: <span className="font-mono text-gray-600 break-all">{userId}</span>
                        </div>
                    )}
                </div>
            </header>

            <main className="container mx-auto p-6">
                {error && (
                    <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6" role="alert">
                        <p>{error}</p>
                    </div>
                )}
                
                {/* 新しい進捗を追加するフォーム */}
                <section className="bg-white p-8 rounded-xl shadow-lg mb-12">
                    <h2 className="text-2xl font-bold mb-4">新しい進捗を記録</h2>
                    <form onSubmit={handleAddProgress} className="space-y-4">
                        <div>
                            <label htmlFor="title" className="block text-sm font-medium text-gray-700">タイトル</label>
                            <input
                                type="text"
                                id="title"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                required
                                className="mt-1 block w-full px-4 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                            />
                        </div>
                        <div>
                            <label htmlFor="description" className="block text-sm font-medium text-gray-700">詳細 (任意)</label>
                            <textarea
                                id="description"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows="3"
                                className="mt-1 block w-full px-4 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                            ></textarea>
                        </div>
                        <div>
                            <label htmlFor="image" className="block text-sm font-medium text-gray-700">画像をアップロード</label>
                            <input
                                type="file"
                                id="image"
                                onChange={(e) => setSelectedFile(e.target.files[0])}
                                required
                                className="mt-1 block w-full text-sm text-gray-900 border border-gray-300 rounded-lg cursor-pointer bg-gray-50 focus:outline-none"
                            />
                            {selectedFile && (
                                <p className="mt-2 text-sm text-gray-500">選択中のファイル: {selectedFile.name}</p>
                            )}
                        </div>
                        <button
                            type="submit"
                            disabled={uploading}
                            className="w-full py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-gray-900 hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 transition-colors disabled:bg-gray-400"
                        >
                            {uploading ? 'アップロード中...' : '記録する'}
                        </button>
                    </form>
                </section>

                {/* 進捗タイムラインの表示 */}
                <section className="relative">
                    <h2 className="text-2xl font-bold mb-8">進捗タイムライン</h2>
                    <div className="absolute left-1/2 transform -translate-x-1/2 w-0.5 bg-gray-300 h-full hidden md:block"></div>

                    <div className="space-y-12 md:space-y-24">
                        {progressItems.length > 0 ? (
                            progressItems.map((item, index) => (
                                <div key={item.id} className={`relative flex items-center ${index % 2 === 0 ? 'md:flex-row-reverse' : ''}`}>
                                    {/* タイムラインの点 */}
                                    <div className="absolute left-1/2 transform -translate-x-1/2 w-4 h-4 rounded-full bg-gray-900 border-2 border-white z-10 hidden md:block"></div>
                                    
                                    {/* カードの内容 */}
                                    <div className={`relative w-full md:w-1/2 ${index % 2 === 0 ? 'md:pr-12' : 'md:pl-12'}`}>
                                        <div className="bg-white rounded-xl shadow-lg overflow-hidden transition-all duration-300 hover:shadow-xl">
                                            {/* 画像とフォールバック */}
                                            <div className="relative w-full aspect-[4/3] bg-gray-200">
                                                <img
                                                    src={item.imageUrl}
                                                    alt={item.title}
                                                    className="w-full h-full object-cover"
                                                    onError={(e) => {
                                                        e.target.onerror = null; // 無限ループを防止
                                                        e.target.src = `https://placehold.co/600x400/F3F4F6/9CA3AF?text=No+Image`;
                                                    }}
                                                />
                                                <div className="absolute top-4 left-4 bg-gray-900 text-white text-xs font-bold px-3 py-1 rounded-full">
                                                    {item.timestamp ? item.timestamp.toLocaleDateString() : '読み込み中...'}
                                                </div>
                                            </div>
                                            <div className="p-6">
                                                {editingItem === item.id ? (
                                                    <form onSubmit={(e) => handleUpdate(e, item.id)} className="space-y-4">
                                                        <input
                                                            type="text"
                                                            value={editTitle}
                                                            onChange={(e) => setEditTitle(e.target.value)}
                                                            className="w-full text-xl font-bold px-2 py-1 border rounded-md"
                                                        />
                                                        <textarea
                                                            value={editDescription}
                                                            onChange={(e) => setEditDescription(e.target.value)}
                                                            className="w-full p-2 border rounded-md"
                                                        ></textarea>
                                                        <div className="flex space-x-2">
                                                            <button type="submit" className="flex-1 py-1 px-3 bg-gray-900 text-white text-sm rounded-md hover:bg-gray-700">更新</button>
                                                            <button type="button" onClick={handleEditCancel} className="flex-1 py-1 px-3 bg-gray-300 text-gray-800 text-sm rounded-md hover:bg-gray-400">キャンセル</button>
                                                        </div>
                                                    </form>
                                                ) : (
                                                    <>
                                                        <h3 className="text-xl font-bold mb-2">{item.title}</h3>
                                                        {item.description && (
                                                            <p className="text-gray-600">{item.description}</p>
                                                        )}
                                                        {userId && (
                                                            <div className="mt-4 flex space-x-2">
                                                                <button onClick={() => handleEditStart(item)} className="py-1 px-3 bg-gray-200 text-gray-800 text-sm rounded-md hover:bg-gray-300">編集</button>
                                                                <button onClick={() => handleDelete(item.id, item.imageUrl)} className="py-1 px-3 bg-red-500 text-white text-sm rounded-md hover:bg-red-600">削除</button>
                                                            </div>
                                                        )}
                                                    </>
                                                )}
                                                
                                                {/* コメントセクション */}
                                                <div className="mt-4 border-t pt-4">
                                                    <h4 className="text-lg font-bold mb-2">コメント</h4>
                                                    <div className="space-y-2">
                                                        {item.comments && item.comments.sort((a, b) => a.timestamp - b.timestamp).map((comment, i) => (
                                                            <div key={i} className="bg-gray-100 p-3 rounded-lg text-sm">
                                                                <p className="text-gray-800">{comment.text}</p>
                                                                <p className="text-gray-500 mt-1 text-xs">{comment.timestamp.toLocaleString()}</p>
                                                            </div>
                                                        ))}
                                                    </div>
                                                    <form onSubmit={(e) => handleAddComment(e, item.id)} className="mt-4">
                                                        <textarea
                                                            name="comment"
                                                            rows="2"
                                                            placeholder="コメントを入力..."
                                                            className="w-full p-2 text-sm border rounded-md focus:ring-blue-500 focus:border-blue-500"
                                                        ></textarea>
                                                        <button
                                                            type="submit"
                                                            className="mt-2 w-full py-1.5 px-4 bg-gray-900 text-white text-sm rounded-md hover:bg-gray-700"
                                                        >
                                                            コメントする
                                                        </button>
                                                    </form>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <p className="text-center text-gray-500">
                                まだ進捗が記録されていません。フォームから最初の記録を追加しましょう！
                            </p>
                        )}
                    </div>
                </section>
            </main>
        </div>
    );
};

export default App;
